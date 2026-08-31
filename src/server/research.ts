import { marketDate } from '../domain/catalyst'
import { toError } from '../domain/failure'
import { ResearchBriefSchema, type ResearchBrief } from '../domain/market'
import { shouldStartDailyResearch } from '../domain/research-schedule'
import { readMarketStatus } from './brokerage-read-tools'
import { type AppEnv } from './env'
import { researchBriefId } from './research-contracts'
import { upsertResearchBrief } from './research-brief-store'
import { brokerApi } from './tastytrade'
import { citationAudit } from './research-citation-audit'
import {
  readingListFromCandidates,
  researchIdeas,
} from './research-output'
import { dailyResearchAgent, type DailyResearchSubmission } from './research-agent'

export function shouldStartScheduledResearch(date: Date): boolean {
  return shouldStartDailyResearch(date)
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

function bindSubmissionSources(
  sources: readonly DailyResearchSubmission['sources'][number][],
): ResearchBrief['sources'] {
  return sources.map((candidate) => ({
    label: candidate.title,
    url: candidate.sourceUrl,
  }))
}

async function resolveResearchInstrumentCatalog(env: AppEnv, now: Date) {
  try {
    const catalog = await brokerApi().resolveResearchInstrumentCatalogFromTastytrade(env, now)
    const result = {
      missingCount: catalog.missingSymbols.length,
      receivedCount: catalog.receivedCount,
      requestedCount: catalog.requestedCount,
      status: 'resolved' as const,
    }
    console.info(JSON.stringify({ event: 'ResearchInstrumentCatalogResolved', ...result }))
    return result
  } catch (cause) {
    const error = toError(cause)
    // Provider bodies and credentials never enter logs; these two labels are controlled
    // by the application and Error constructor, and the durable step records the degraded result.
    const result = {
      errorCode: error?.message.match(/^[A-Za-z][A-Za-z0-9]*(?::\d{3})?/)?.[0] ?? 'UnknownError',
      errorName: error?.name ?? 'Error',
      status: 'unavailable' as const,
    }
    console.error(JSON.stringify({ event: 'ResearchInstrumentCatalogUnavailable', ...result }))
    return result
  }
}

async function persistDailyResearch(
  env: AppEnv,
  brief: ResearchBrief,
): Promise<void> {
  if (!env.DB) throw new Error('DailyResearchPersistenceUnavailable')
  await upsertResearchBrief(env.DB, brief)
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
    await runTask(
      'resolve-instrument-catalog',
      () => resolveResearchInstrumentCatalog(env, now),
    )
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
  const sources = bindSubmissionSources(submission.sources)
  console.info(JSON.stringify({
    event: 'DailyResearchModelCompleted',
    runId: gatewayRunId,
  }))
  const proposed = researchIdeas(submission.ideas, sources)
  // The model that wrote these claims cannot vouch for them, and nothing downstream reads a
  // cited page. An idea whose own sources do not state it is dropped here rather than
  // published beside a citation that does not hold.
  const audit = await runTask('audit-citations', () => citationAudit().audit(env, {
    ideas: proposed,
    marketDate: today,
    runId: gatewayRunId,
  }))
  console.info(JSON.stringify({
    event: 'DailyResearchCitationAudit',
    kept: audit.ideas.length,
    proposed: proposed.length,
    rejected: audit.rejected,
    runId: gatewayRunId,
    status: audit.status,
  }))
  const ideas = audit.ideas
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
