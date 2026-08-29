import {
  CatalystSchema,
  isValidIsoDate,
  marketDate,
  recentCodexWebCatalysts,
  type Catalyst,
} from '../domain/catalyst'
import { type JsonValue } from '../domain/json-payload'
import { ResearchBriefSchema, type ResearchBrief, type Ticker } from '../domain/market'
import { persistResearchedCatalysts } from './catalysts'
import { type AppEnv } from './env'
import {
  MAX_DAILY_RESEARCH_LEADS,
  MAX_DAILY_RESEARCH_SYMBOLS,
  addDays,
  researchBriefId,
  type ResearchSourceItem,
} from './research-contracts'
import { bindEvidenceSymbols } from './research-evidence'
import { marketMoverResearch } from './research-market-movers'
import {
  marketMoverInsightsFromCandidates,
  marketMoverPacket,
  mentionsDiscoverySource,
  redditCatalystsFromCandidates,
  readingListFromCandidates,
  researchIdeasForDate,
  researchPlayTuple,
  UNCONFIRMED_MOVER_HEADLINE,
} from './research-output'
import { equityOptionContractFromChainTuple } from './option-contract'
import { searchRecentTickerCoverage } from './research-coverage'
import {
  dailyResearchAgent,
  type DailyResearchSubmission,
  type ResearchMarketMetrics,
} from './research-agent'
import { researchSources } from './research-sources'
import { readStoredSecret } from './secrets'
import { brokerApi } from './tastytrade'
import { internalWatchlistWriter } from './internal-watchlist'
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
    && ['30', '40', '50'].includes(parts.minute)
}

function catalystEvidence(catalysts: readonly Catalyst[]): ResearchSourceItem[] {
  return catalysts.map((catalyst) => ({
    source: catalyst.source,
    title: catalyst.title,
    url: catalyst.sourceUrl,
    publishedAt: catalyst.updatedAt,
    context: `Scheduled ${catalyst.kind} on ${catalyst.date} (${catalyst.timing}, ${catalyst.confidence}). ${catalyst.description ?? catalyst.title}`,
    symbols: [catalyst.symbol],
  }))
}

function compactMarketMetrics(
  tickers: readonly Ticker[],
  focusSymbols: ReadonlySet<string>,
): ResearchMarketMetrics[] {
  return tickers.filter((ticker) => focusSymbols.has(ticker.symbol)).map((ticker) => {
    const compact: ResearchMarketMetrics = {
      symbol: ticker.symbol,
      name: ticker.name,
      price: ticker.price,
      ivRank: ticker.ivRank,
      ivPercentile: ticker.ivPercentile,
      ivIndex: ticker.ivIndex,
      liquidity: ticker.liquidity,
      earningsDate: ticker.earningsDate,
    }
    if (ticker.marketCap !== undefined) compact.marketCap = ticker.marketCap
    if (ticker.volume !== undefined) compact.volume = ticker.volume
    return compact
  })
}

// Research only the bounded private list; public projections and brokerage positions
// never widen the agent's scope.
function researchSymbols(watchlists: readonly { kind: string; symbols: readonly string[] }[]): string[] {
  return [...new Set(watchlists
    .filter((watchlist) => watchlist.kind === 'private')
    .flatMap((watchlist) => watchlist.symbols.map((symbol) => symbol.toUpperCase())))]
    .slice(0, MAX_DAILY_RESEARCH_SYMBOLS)
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

/**
 * ask-dan published useful links surfaced by public discussion, but discussion itself is
 * not evidence in Spice. Only a page the collector actually fetched crosses this seam;
 * post text, scores, comments, and discovery provenance stay private.
 */
function discussionLinkEvidence(evidence: readonly ResearchSourceItem[]): ResearchSourceItem[] {
  return evidence.flatMap((item) => {
    const linkedPages = item.linkedPages
      ?? (item.outbound?.excerpt ? [{
        ...item.outbound,
        excerpt: item.outbound.excerpt,
        title: item.outbound.title ?? item.outbound.label,
      }] : [])
    return linkedPages.map((link) => ({
      context: link.excerpt,
      publishedAt: item.publishedAt,
      source: `Linked-page discovery · ${link.label}`,
      symbols: item.symbols,
      title: link.title,
      url: link.url,
    }))
  })
}

/**
 * Keep ask-dan's discussion-led discovery while reserving room for each stronger Spice
 * channel. Up to six discussion names establish the baseline; local Codex, movers, and
 * official sources then contribute round-robin before any remaining discussion name.
 * Grok's native X research still sees all maintained symbols in the single agent turn.
 */
function researchCandidateSymbols(
  discussion: readonly ResearchSourceItem[],
  codexCatalysts: readonly ResearchSourceItem[],
  movers: readonly ResearchSourceItem[],
  official: readonly ResearchSourceItem[],
  allowed: ReadonlySet<string>,
): string[] {
  const sourceSymbols = (items: readonly ResearchSourceItem[]) => [...new Set(
    items.flatMap((item) => item.symbols ?? []).filter((symbol) => allowed.has(symbol)),
  )]
  const discussionSymbols = sourceSymbols(discussion)
  const accepted = new Set(discussionSymbols.slice(0, 6))
  const spiceGroups = [codexCatalysts, movers, official].map(sourceSymbols)
  const longestGroup = Math.max(0, ...spiceGroups.map((group) => group.length))
  for (let index = 0; index < longestGroup && accepted.size < MAX_DAILY_RESEARCH_LEADS; index += 1) {
    for (const group of spiceGroups) {
      const symbol = group[index]
      if (symbol !== undefined && !accepted.has(symbol)) {
        accepted.add(symbol)
        if (accepted.size === MAX_DAILY_RESEARCH_LEADS) break
      }
    }
  }
  for (const symbol of discussionSymbols.slice(6)) {
    if (accepted.size === MAX_DAILY_RESEARCH_LEADS) break
    accepted.add(symbol)
  }
  return [...accepted]
}

export interface GenerateDailyResearchOptions {
  persist?: boolean
  requireMarketOpen?: boolean
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
    const sourceUrl = safeHttpsUrl(candidate.sourceUrl)
    if (!sourceUrl || !allowedSymbols.has(candidate.symbol)) return undefined
    if (candidate.evidenceIndex !== null) {
      const source = baseEvidence[candidate.evidenceIndex]
      if (!source?.symbols?.includes(candidate.symbol)) return undefined
      const ownedUrls = [source.url, source.outbound?.url]
        .flatMap((url) => url ? [safeHttpsUrl(url)] : [])
      return ownedUrls.includes(sourceUrl) ? candidate.evidenceIndex : undefined
    }
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
    marketMovers: submission.marketMovers.flatMap((mover) => {
      const mapped = remap(mover.sourceIndices)
      return mapped.length ? [{ ...mover, sourceIndices: mapped }] : []
    }),
    readingList: submission.readingList.flatMap((item) => {
      const sourceIndex = sourceIndices[item.sourceIndex]
      return sourceIndex === undefined ? [] : [{ ...item, sourceIndex }]
    }),
  }
}

function xCatalystsFromSubmission(
  submission: DailyResearchSubmission,
  citations: ReadonlySet<string>,
  allowedSymbols: ReadonlySet<string>,
  now: Date,
): Catalyst[] {
  const today = marketDate(now)
  const horizon = addDays(today, 180)
  const accepted = new Map<string, Catalyst>()
  for (const candidate of submission.xCatalysts) {
    const source = submission.sources[candidate.sourceIndex]
    const sourceUrl = source && canonicalXPostUrl(source.sourceUrl)
    if (!source || source.symbol !== candidate.symbol || !allowedSymbols.has(candidate.symbol)
      || !sourceUrl || !citations.has(sourceUrl) || !isValidIsoDate(candidate.date)
      || candidate.date < today || candidate.date > horizon) continue
    const id = `xai-x-search:${candidate.symbol}:${candidate.kind}:${candidate.date}`
    const catalyst = CatalystSchema.parse({
      ...candidate,
      id,
      source: 'Grok 4.6 X research',
      sourceUrl,
      updatedAt: now.toISOString(),
    })
    const current = accepted.get(id)
    if (!current || (current.confidence === 'estimated' && catalyst.confidence === 'confirmed')) {
      accepted.set(id, catalyst)
    }
  }
  return [...accepted.values()]
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
  ideas: ResearchBrief['ideas'],
  today: string,
  runId: string,
): Promise<ResearchBrief['ideas']> {
  const chains = new Map<string, JsonValue | undefined>()
  const verified: ResearchBrief['ideas'] = []
  let chainUnavailable = 0
  let checked = 0
  let structureCleared = 0
  for (const idea of ideas) {
    // A stored idea may carry no play at all; there is then no contract to verify.
    if (idea.play === null) {
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
    const tuple = researchPlayTuple(idea.play, today)
    if (!tuple) {
      structureCleared += 1
      verified.push({ ...idea, play: null })
      continue
    }
    try {
      // A malformed or incomplete chain payload throws here too, so it counts as a
      // contract the chain does not list; only a failed fetch is an outage.
      equityOptionContractFromChainTuple(chain, tuple)
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

async function persistDailyResearch(
  env: AppEnv,
  brief: ResearchBrief,
  redditCatalysts: readonly Catalyst[],
  xCatalysts: readonly Catalyst[],
  now: Date,
): Promise<void> {
  await internalWatchlistWriter().ensureSymbols(
    env,
    [...brief.ideas.map((idea) => idea.symbol), ...brief.marketMovers.map((mover) => mover.symbol)],
    'scheduled-research',
    now,
  )
  await Promise.all([
    persistResearchedCatalysts(env, 'reddit', redditCatalysts, now),
    persistResearchedCatalysts(env, 'x', xCatalysts, now),
  ])
  if (!env.DB) return
  await env.DB.prepare(
    `INSERT INTO research_briefs (id, published_at, payload_json)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET published_at = excluded.published_at, payload_json = excluded.payload_json`,
  ).bind(brief.id, brief.publishedAt, JSON.stringify(brief)).run()
}

/**
 * Deterministic collectors prepare the ask-dan-style evidence packet, then one Pi turn
 * lets Grok use native X and web research before submitting the typed final report.
 * Local Codex catalysts remain complementary snapshot evidence; a missing laptop run
 * simply leaves that part of the packet empty.
 */
export async function generateDailyResearch(
  env: AppEnv,
  now = new Date(),
  options: GenerateDailyResearchOptions = {},
): Promise<ResearchBrief> {
  const persist = options.persist ?? true
  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) throw new Error('RedditResearchUnavailable')
  const [redditClientId, redditClientSecret, snapshot] = await Promise.all([
    readStoredSecret(env.REDDIT_CLIENT_ID, 'REDDIT_CLIENT_ID'),
    readStoredSecret(env.REDDIT_CLIENT_SECRET, 'REDDIT_CLIENT_SECRET'),
    brokerApi().loadMarketSnapshot(env),
  ])
  if (options.requireMarketOpen && snapshot.marketState !== 'open') {
    throw new Error(`DailyResearchMarketNotOpen:${snapshot.marketState}`)
  }
  const symbols = researchSymbols(snapshot.watchlists)
  const today = marketDate(now)
  const gatewayRunId = crypto.randomUUID()
  const sources = researchSources()
  const focusSymbols = new Set(symbols)
  const compactMarket = compactMarketMetrics(snapshot.tickers, focusSymbols)
  const codexWebCatalysts = recentCodexWebCatalysts(snapshot.catalysts, focusSymbols, now)
  const codexEvidence = bindEvidenceSymbols(catalystEvidence(codexWebCatalysts), compactMarket)
  const [officialEvidence, redditEvidence, marketMoverEvidence] = await Promise.all([
    sources.collectOfficialSources(),
    sources.collectRedditSources({ clientId: redditClientId, clientSecret: redditClientSecret }),
    marketMoverResearch().collect(now),
  ])
  const discussionEvidence = bindEvidenceSymbols(redditEvidence, compactMarket)
  const moverDiscoveryEvidence = bindEvidenceSymbols(marketMoverEvidence, compactMarket)
  const officialDiscoveryEvidence = bindEvidenceSymbols(officialEvidence, compactMarket)
  const allowedCandidates = new Set(compactMarket.map((ticker) => ticker.symbol))
  const candidateSymbols = researchCandidateSymbols(
    discussionEvidence,
    codexEvidence,
    moverDiscoveryEvidence,
    officialDiscoveryEvidence,
    allowedCandidates,
  )
  const [tickerEvidence, recentCoverage] = await Promise.all([
    sources.collectTickerSources(candidateSymbols, now),
    searchRecentTickerCoverage(env, [...allowedCandidates], now),
  ])
  const baseEvidence = bindEvidenceSymbols([
    ...officialEvidence,
    ...tickerEvidence,
    ...discussionLinkEvidence(discussionEvidence),
    ...codexEvidence,
    ...marketMoverEvidence,
  ], compactMarket)
  const detectedMovers = marketMoverPacket(baseEvidence)
  const agent = await dailyResearchAgent().run(env, {
    candidateSymbols,
    detectedMovers,
    evidence: baseEvidence,
    marketMetrics: compactMarket,
    now,
    recentCoverage,
    redditEvidence: discussionEvidence,
    runId: gatewayRunId,
    symbols,
  })
  const boundSources = bindSubmissionSources(
    agent.submission.sources,
    baseEvidence,
    allowedCandidates,
    agent.citations,
  )
  const evidence = boundSources.evidence
  const generated = remapSubmissionSources(agent.submission, boundSources.indices)
  const redditCatalysts = redditCatalystsFromCandidates(
    agent.submission.redditCatalysts.map(({ redditEvidenceIndex, ...candidate }) => ({
      ...candidate,
      sourceIndex: redditEvidenceIndex,
    })),
    discussionEvidence,
    symbols,
    now,
  )
  const xCatalysts = xCatalystsFromSubmission(agent.submission, agent.citations, allowedCandidates, now)
  // The Codex count is the only trace of whether the laptop runner contributed:
  // an empty packet from a closed laptop and one from a failed run look the same.
  console.info(JSON.stringify({
    event: 'DailyResearchModelCompleted',
    codexWebCatalysts: codexWebCatalysts.length,
    runId: gatewayRunId,
  }))
  const marketMovers = marketMoverInsightsFromCandidates(generated.marketMovers, evidence)
  // No model output is retained, so without this counter a run where the editor
  // returned no movers is indistinguishable from one where every candidate failed
  // deterministic binding and fell back to the unconfirmed headline.
  console.info(JSON.stringify({
    event: 'DailyResearchMoversBound',
    bound: marketMovers.filter((mover) => mover.headline !== UNCONFIRMED_MOVER_HEADLINE).length,
    candidates: generated.marketMovers.length,
    detected: marketMovers.length,
    runId: gatewayRunId,
  }))
  // A watched symbol can lack a complete current tastytrade row. Bind ideas to
  // the exact metrics packet supplied to the editor, not the wider source universe.
  const boundIdeas = researchIdeasForDate(generated.ideas, today, evidence, [...allowedCandidates], recentCoverage)
  // Only a bound idea is worth a chain request: binding has already proved the symbol
  // and citations, and normalized an invalid or uncertain expression to no play.
  const ideas = await chainVerifiedIdeas(env, boundIdeas, today, gatewayRunId)
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
  const brief = ResearchBriefSchema.parse({
    title: mentionsDiscoverySource(generated.title) ? `Options read for ${today}` : generated.title,
    summary,
    regime: mentionsDiscoverySource(generated.regime) ? 'Selective' : generated.regime,
    regimeDetail: mentionsDiscoverySource(generated.regimeDetail) ? 'Only independently supported setups survived.' : generated.regimeDetail,
    ideas,
    marketMovers,
    readingList,
    id: researchBriefId(today),
    // Dated when the brief exists, not when the single agent run started.
    publishedAt: new Date().toISOString(),
    sources: researchSourceLinks(evidence),
  })
  // Deterministic validation has now bound every surviving idea and mover to a
  // trusted symbol. Scheduled discovery is therefore safe to remember without
  // parsing arbitrary model prose for ticker-like words.
  if (persist) await persistDailyResearch(env, brief, redditCatalysts, xCatalysts, now)
  return brief
}
