import { marketDate } from '../domain/catalyst'
import { ResearchBriefSchema, type ResearchBrief } from '../domain/market'
import { readMarketStatus } from './brokerage-read-tools'
import { type AppEnv } from './env'
import { researchBriefId } from './research-contracts'
import {
  readingListFromCandidates,
  researchIdeas,
} from './research-output'
import { dailyResearchAgent, type DailyResearchSubmission } from './research-agent'

function newYorkParts(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date)
  return Object.fromEntries(parts.map((part) => [part.type, part.value]))
}

export function shouldRunDailyResearch(date: Date): boolean {
  const parts = newYorkParts(date)
  return parts.weekday !== 'Sat' && parts.weekday !== 'Sun' && parts.hour === '09'
    && parts.minute === '30'
}

/** Publish only sources the editor selected for an idea or the reading list. */
function researchSourceLinks(
  ideas: ResearchBrief['ideas'],
  readingList: ResearchBrief['readingList'],
): ResearchBrief['sources'] {
  return [
    ...ideas.flatMap((idea) => idea.sources),
    ...readingList.map((item) => ({ label: item.title, url: item.url })),
  ]
}

export interface GenerateDailyResearchOptions {
  persist?: boolean
  requireMarketOpen?: boolean
  runStep?: <T>(name: string, task: () => Promise<T>) => Promise<T>
}

function safeHttpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

function bindSubmissionSources(
  sources: readonly DailyResearchSubmission['sources'][number][],
  citations: ReadonlySet<string>,
): ResearchBrief['sources'] {
  return sources.map((candidate, candidateIndex) => {
    const sourceUrl = safeHttpsUrl(candidate.sourceUrl)
    if (!sourceUrl) throw new Error(`DailyResearchOutput:invalid-native-source-url:${candidateIndex}`)
    if (!citations.has(sourceUrl)) throw new Error(`DailyResearchOutput:uncited-native-source:${candidateIndex}`)
    return {
      label: `Grok research · ${new URL(sourceUrl).hostname.replace(/^www\./, '')} · ${candidate.title}`,
      url: sourceUrl,
    }
  })
}

async function persistDailyResearch(
  env: AppEnv,
  brief: ResearchBrief,
): Promise<void> {
  if (!env.DB) throw new Error('DailyResearchPersistenceUnavailable')
  await env.DB.prepare(
    `INSERT INTO research_briefs (id, published_at, payload_json)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET published_at = excluded.published_at, payload_json = excluded.payload_json`,
  ).bind(brief.id, brief.publishedAt, JSON.stringify(brief)).run()
}

/** One autonomous Pi agent discovers, researches, and submits the typed daily report. */
export async function generateDailyResearch(
  env: AppEnv,
  now = new Date(),
  options: GenerateDailyResearchOptions = {},
): Promise<ResearchBrief> {
  const persist = options.persist ?? true
  const runTask = <T>(name: string, task: () => Promise<T>): Promise<T> => (
    options.runStep ? options.runStep(name, task) : task()
  )
  if (options.requireMarketOpen) {
    const status = await runTask('market-status', () => readMarketStatus(env, now))
    if (status.state !== 'open') throw new Error(`DailyResearchMarketNotOpen:${status.state}`)
  }
  const today = marketDate(now)
  // Workflow replay must keep one transcript identity for every provider turn.
  const gatewayRunId = await runTask('run-id', async () => crypto.randomUUID())
  const agent = await dailyResearchAgent().run(env, {
    now,
    runId: gatewayRunId,
    runStep: options.runStep,
  })
  const { submission } = agent
  const sources = bindSubmissionSources(submission.sources, agent.citations)
  console.info(JSON.stringify({
    event: 'DailyResearchModelCompleted',
    runId: gatewayRunId,
  }))
  const ideas = researchIdeas(submission.ideas, sources)
  const readingList = readingListFromCandidates(submission.readingList, sources)
  // Persist the completion time so replay cannot return a timestamp different from D1.
  const publishedAt = await runTask('published-at', async () => new Date().toISOString())
  const brief = ResearchBriefSchema.parse({
    title: submission.title,
    summary: submission.summary,
    regime: submission.regime,
    regimeDetail: submission.regimeDetail,
    ideas,
    readingList,
    id: researchBriefId(today),
    // Dated when the brief exists, not when the single agent run started.
    publishedAt,
    sources: researchSourceLinks(ideas, readingList),
  })
  if (persist) {
    await runTask('persist-report', async () => {
      await persistDailyResearch(env, brief)
      return true
    })
  }
  return brief
}
