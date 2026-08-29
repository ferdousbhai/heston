import { marketDate } from '../domain/catalyst'
import { type JsonValue } from '../domain/json-payload'
import { ResearchBriefSchema, type ResearchBrief } from '../domain/market'
import { readMarketStatus } from './brokerage-read-tools'
import { type AppEnv } from './env'
import { researchBriefId, type ResearchSourceItem } from './research-contracts'
import { bindEvidenceSymbols } from './research-evidence'
import {
  mentionsDiscoverySource,
  readingListFromCandidates,
  researchIdeas,
  type BoundResearchIdea,
} from './research-output'
import { equityOptionContractFromChainTuple } from './option-contract'
import { dailyResearchAgent, type DailyResearchSubmission } from './research-agent'
import { brokerApi } from './tastytrade'
import { canonicalXPostUrl } from './x-url'

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

/**
 * A model citing an item by index must otherwise count array positions in a long
 * serialized packet, and a miscount is indistinguishable from a fabricated index
 * once the deterministic binder rejects it. Every packet item therefore carries
 * its own index field. The emitted index is always the array position, so the
 * binders keep resolving citations positionally against the same array.
 */
function researchSourceLinks(evidence: readonly ResearchSourceItem[]): ResearchBrief['sources'] {
  const links: ResearchBrief['sources'] = [
    { label: 'tastytrade market metrics', url: 'https://developer.tastytrade.com/open-api-spec/market-metrics/' },
  ]
  for (const item of evidence) {
    links.push({ label: `${item.source} · ${item.title}`, url: item.url })
    if (item.outbound) links.push({ label: `Linked · ${item.outbound.label}`, url: item.outbound.url })
  }
  return [...new Map(links.map((link) => [link.url, link])).values()]
}

export interface GenerateDailyResearchOptions {
  persist?: boolean
  requireMarketOpen?: boolean
  runStep?: <T>(name: string, task: () => Promise<T>) => Promise<T>
}

function safeHttpsUrl(value: string): string | undefined {
  const xPostUrl = canonicalXPostUrl(value)
  if (xPostUrl) return xPostUrl
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return undefined
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

interface BoundSubmissionSources {
  evidence: ResearchSourceItem[]
  indices: Array<number | undefined>
}

function bindSubmissionSources(
  sources: readonly DailyResearchSubmission['sources'][number][],
  baseEvidence: readonly ResearchSourceItem[],
  allowedSymbols: ReadonlySet<string>,
  citations: ReadonlySet<string>,
): BoundSubmissionSources {
  const evidence = [...baseEvidence]
  const searched = new Map<string, number>()
  const indices = sources.map((candidate) => {
    if (candidate.evidenceIndex !== null) {
      const source = baseEvidence[candidate.evidenceIndex]
      if (!source?.symbols?.includes(candidate.symbol)) return undefined
      return allowedSymbols.has(candidate.symbol) ? candidate.evidenceIndex : undefined
    }
    const sourceUrl = safeHttpsUrl(candidate.sourceUrl)
    if (!sourceUrl || !allowedSymbols.has(candidate.symbol)) return undefined
    if (!citations.has(sourceUrl)) return undefined
    const key = `${candidate.symbol}:${sourceUrl}`
    const existing = searched.get(key)
    if (existing !== undefined) return existing
    const index = evidence.length
    evidence.push({
      context: candidate.context,
      source: `Grok research · ${new URL(sourceUrl).hostname.replace(/^www\./, '')}`,
      symbols: [candidate.symbol],
      title: candidate.title,
      url: sourceUrl,
    })
    searched.set(key, index)
    return index
  })
  return { evidence, indices }
}

function remapSubmissionSources(
  submission: DailyResearchSubmission,
  sourceIndices: readonly (number | undefined)[],
) {
  const remap = (indices: readonly number[]) => [...new Set(indices.flatMap((index) => {
    const mapped = sourceIndices[index]
    return mapped === undefined ? [] : [mapped]
  }))]
  return {
    title: submission.title,
    summary: submission.summary,
    regime: submission.regime,
    regimeDetail: submission.regimeDetail,
    ideas: submission.ideas.flatMap((idea) => {
      const mapped = remap(idea.sourceIndices)
      return mapped.length ? [{ ...idea, sourceIndices: mapped }] : []
    }),
    readingList: submission.readingList.flatMap((item) => {
      const sourceIndex = sourceIndices[item.sourceIndex]
      return sourceIndex === undefined ? [] : [{ ...item, sourceIndex }]
    }),
  }
}

/**
 * Resolve every surviving idea's optional play against the current tastytrade chain.
 *
 * A play is illustrative, but a reader acts on it, and the editor writes it from prose: a
 * production brief shipped plays expiring on a Sunday. The weekday rule in
 * `research-output` fixed impossible dates without knowing which contracts tastytrade
 * actually lists, so the exact tuple is resolved here through the same chain resolver the
 * order path uses. Chains are fetched once per underlying and released immediately; a
 * brief carries at most three ideas.
 *
 * Outage posture: an unreadable chain clears the illustrative contract rather than
 * publishing a date-validated guess. The independently bound thesis survives as
 * "structure pending"; model output still never establishes an executable contract.
 */
async function chainVerifiedIdeas(
  env: AppEnv,
  ideas: readonly BoundResearchIdea[],
  runId: string,
): Promise<ResearchBrief['ideas']> {
  const chains = new Map<string, JsonValue | undefined>()
  const verified: ResearchBrief['ideas'] = []
  let chainUnavailable = 0
  let checked = 0
  let structureCleared = 0
  for (const { contract, idea } of ideas) {
    // A thesis may carry no proposed contract; there is then no chain lookup to make.
    if (contract === null) {
      verified.push(idea)
      continue
    }
    checked += 1
    if (!chains.has(idea.symbol)) {
      chains.set(idea.symbol, await brokerApi()
        .tastyRequest(env, `/option-chains/${encodeURIComponent(idea.symbol)}`)
        .catch(() => undefined))
    }
    const chain = chains.get(idea.symbol)
    if (!chain) {
      chainUnavailable += 1
      structureCleared += 1
      verified.push({ ...idea, play: null })
      continue
    }
    try {
      // A malformed or incomplete chain payload throws here too, so it counts as a
      // contract the chain does not list; only a failed fetch is an outage.
      equityOptionContractFromChainTuple(chain, contract)
      verified.push(idea)
    } catch {
      structureCleared += 1
      verified.push({ ...idea, play: null })
    }
  }
  // Without this counter a cleared structure looks identical to an editor that proposed
  // no option at all, and a broker outage looks like an intentional thesis-only idea.
  console.info(JSON.stringify({
    event: 'DailyResearchPlaysChecked',
    chainUnavailable,
    checked,
    dropped: 0,
    runId,
    structureCleared,
  }))
  return verified
}

function boundResearchSummary(
  generatedSummary: string,
  candidateCount: number,
  ideas: ResearchBrief['ideas'],
): string {
  if (ideas.length === candidateCount && ideas.length > 0 && !mentionsDiscoverySource(generatedSummary)) {
    return generatedSummary
  }
  if (!ideas.length) return 'No evidence-linked options thesis was strong enough to surface today.'
  const headlines = ideas.slice(0, 2).map((idea) => idea.headline).join('; ')
  return `${ideas.length} evidence-linked setup${ideas.length === 1 ? '' : 's'} survived validation: ${headlines}.`
}

function completeEditorialFrame(candidateCount: number, ideas: ResearchBrief['ideas']): boolean {
  return candidateCount > 0 && ideas.length === candidateCount
}

async function persistDailyResearch(
  env: AppEnv,
  brief: ResearchBrief,
): Promise<void> {
  if (!env.DB) return
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
  const baseEvidence = bindEvidenceSymbols(agent.evidence, agent.marketMetrics)
  const allowedCandidates = new Set(agent.marketMetrics.map((ticker) => ticker.symbol))
  const boundSources = bindSubmissionSources(
    agent.submission.sources,
    baseEvidence,
    allowedCandidates,
    agent.citations,
  )
  const evidence = boundSources.evidence
  const generated = remapSubmissionSources(agent.submission, boundSources.indices)
  console.info(JSON.stringify({
    event: 'DailyResearchModelCompleted',
    runId: gatewayRunId,
  }))
  const boundIdeas = researchIdeas(
    generated.ideas,
    evidence,
    [...allowedCandidates],
  )
  // Only a bound idea is worth a chain request: binding has already proved the symbol
  // and citations, and normalized an out-of-horizon expression to no play.
  const ideas = await runTask(
    'verify-option-chains',
    () => chainVerifiedIdeas(env, boundIdeas, gatewayRunId),
  )
  // A zero-idea brief is otherwise silent about whether the editor surfaced nothing or
  // every thesis failed symbol, coverage, citation, or discovery-provider validation.
  console.info(JSON.stringify({
    event: 'DailyResearchIdeasBound',
    bound: ideas.length,
    candidates: generated.ideas.length,
    runId: gatewayRunId,
  }))
  const readingList = readingListFromCandidates(generated.readingList, evidence)
  // If deterministic validation removes an editor candidate, do not retain a
  // top-level summary that may still repeat the rejected thesis.
  const summary = boundResearchSummary(generated.summary, generated.ideas.length, ideas)
  const completeFrame = completeEditorialFrame(generated.ideas.length, ideas)
  // Persist the completion time so replay cannot return a timestamp different from D1.
  const publishedAt = await runTask('published-at', async () => new Date().toISOString())
  const brief = ResearchBriefSchema.parse({
    title: completeFrame && !mentionsDiscoverySource(generated.title)
      ? generated.title
      : `Options read for ${today}`,
    summary,
    regime: mentionsDiscoverySource(generated.regime) ? 'Selective' : generated.regime,
    regimeDetail: completeFrame && !mentionsDiscoverySource(generated.regimeDetail)
      ? generated.regimeDetail
      : 'Only independently supported setups survived.',
    ideas,
    readingList,
    id: researchBriefId(today),
    // Dated when the brief exists, not when the single agent run started.
    publishedAt,
    sources: researchSourceLinks(evidence),
  })
  if (persist) {
    await runTask('persist-report', async () => {
      await persistDailyResearch(env, brief)
      return true
    })
  }
  return brief
}
