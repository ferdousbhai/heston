import { CatalystSchema, isValidIsoDate, marketDate, type Catalyst } from '../domain/catalyst'
import {
  MarketMoverInsightSchema,
  ResearchIdeaSchema,
  ResearchReadingLinkSchema,
  type ResearchBrief,
} from '../domain/market'
import { type DailyResearchSubmission } from './research-agent'
import { type RecentTickerCoverage } from './research-coverage'
import { addDays, type ResearchSourceItem } from './research-contracts'
import { REDDIT_RESEARCH_SOURCE } from './research-reddit'

type ResearchIdeaCandidate = DailyResearchSubmission['ideas'][number]
type ReadingLinkCandidate = DailyResearchSubmission['readingList'][number]
type MarketMoverCandidate = DailyResearchSubmission['marketMovers'][number]
type RedditCatalystCandidate = Omit<DailyResearchSubmission['redditCatalysts'][number], 'redditEvidenceIndex'> & {
  sourceIndex: number
}

/**
 * Exchange holidays that land on a Friday, so the week's options expire the Thursday
 * before instead. Only Good Friday and holidays whose observed date lands on a Friday
 * can appear here; every other US market holiday falls on a Monday or a Thursday and
 * leaves that week's Friday expiration intact.
 *
 * Plays are bounded to a 90-day horizon, so this list only has to stay a year ahead;
 * extend it before its last entry falls inside that horizon. Past the listed years the
 * rule still accepts Fridays and rejects Thursdays, which is right for every ordinary
 * week and merely conservative in a holiday one.
 */
const EXCHANGE_HOLIDAY_FRIDAYS: ReadonlySet<string> = new Set([
  '2026-04-03', // Good Friday
  '2026-06-19', // Juneteenth National Independence Day
  '2026-07-03', // Independence Day observed
  '2026-12-25', // Christmas Day
  '2027-01-01', // New Year's Day
  '2027-03-26', // Good Friday
  '2027-06-18', // Juneteenth observed
  '2027-12-24', // Christmas Day observed
  '2028-04-14', // Good Friday
  '2029-03-30', // Good Friday
])

/**
 * US equity options expire on a Friday, or on the Thursday before when that Friday is an
 * exchange holiday. A model can emit a well-formed date that no option chain lists — a
 * production brief shipped two plays expiring Sunday 2026-09-20 — so the expiration
 * weekday is decided here rather than trusted from model prose.
 */
function isOptionExpirationDate(isoDate: string): boolean {
  const weekday = new Date(`${isoDate}T00:00:00.000Z`).getUTCDay()
  if (weekday === 5) return !EXCHANGE_HOLIDAY_FRIDAYS.has(isoDate)
  return weekday === 4 && EXCHANGE_HOLIDAY_FRIDAYS.has(addDays(isoDate, 1))
}

function playExpiryDate(play: string, today: string): string | undefined {
  const rawMonthDay = play.split(' ').at(-1)
  const [month, day] = (rawMonthDay ?? '').split('/').map(Number)
  const year = Number(today.slice(0, 4))
  if (!month || !day || !Number.isSafeInteger(year)) return undefined
  for (const candidateYear of [year, year + 1]) {
    const date = new Date(Date.UTC(candidateYear, month - 1, day))
    if (date.getUTCFullYear() !== candidateYear || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) continue
    const isoDate = date.toISOString().slice(0, 10)
    if (isoDate >= today) return isoDate
  }
  return undefined
}

/**
 * The chain-resolver tuple for a `TICKER STRIKE(c/p) M/D` play. It is declared here rather
 * than imported so this module keeps no broker dependency; it is structurally the
 * `EquityOptionTuple` that `option-contract` resolves against a live chain.
 */
export interface ResearchPlayTuple {
  expiry: string
  optionType: 'C' | 'P'
  strike: number
  underlying: string
}

/**
 * The exact contract an editor play names. The weekday rule above only proves the date
 * *could* be an expiration; resolving this tuple against the current chain is what proves
 * the contract is actually listed.
 */
export function researchPlayTuple(play: string, today: string): ResearchPlayTuple | undefined {
  const [underlying, contract] = play.split(' ')
  const expiry = playExpiryDate(play, today)
  if (!underlying || !contract || expiry === undefined) return undefined
  const optionType = contract.endsWith('c') ? 'C' : contract.endsWith('p') ? 'P' : undefined
  const strike = Number(contract.slice(0, -1))
  if (!optionType || !Number.isFinite(strike) || strike <= 0) return undefined
  return { expiry, optionType, strike, underlying }
}

function normalizedThesis(headline: string, description: string): string {
  return `${headline} ${description}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function coverageReviewIsValid(
  idea: ResearchIdeaCandidate,
  selectedEvidence: readonly (ResearchSourceItem | undefined)[],
  recentCoverage: readonly RecentTickerCoverage[],
): boolean {
  const expectedIndices = recentCoverage.flatMap((coverage, index) => (
    coverage.symbol === idea.symbol ? [index] : []
  ))
  const reviewedIndices = [...new Set(idea.recentCoverageIndices)]
  if (!expectedIndices.length) return !reviewedIndices.length && !idea.thesisChange
  if (reviewedIndices.length !== expectedIndices.length
    || reviewedIndices.some((index) => !expectedIndices.includes(index))) return false

  const latestPriorCoverage = Math.max(...expectedIndices.map((index) => (
    Date.parse(recentCoverage[index]!.publishedAt)
  )))
  if (!selectedEvidence.some((source) => (
    source?.publishedAt !== undefined && Date.parse(source.publishedAt) > latestPriorCoverage
  ))) return false

  // A still-valid thesis may be repeated when genuinely newer same-symbol evidence
  // supports it. This restores the old daily recommendation cadence without allowing
  // stale copy to recycle: all prior rows must be reviewed and newer evidence is still
  // mandatory. A claimed update additionally has to differ from prior thesis text.
  if (!idea.thesisChange) {
    return expectedIndices.every((index) => recentCoverage[index]!.direction === idea.direction)
  }
  const currentThesis = normalizedThesis(idea.headline, idea.description)
  return expectedIndices.every((index) => normalizedThesis(
    recentCoverage[index]!.headline,
    recentCoverage[index]!.description,
  ) !== currentThesis)
}

/**
 * Enforce the prompt's expiry horizon in code; a valid-looking model date can still be
 * impossible, stale, or a calendar day on which no option expires.
 */
export function researchIdeasForDate(
  ideas: readonly ResearchIdeaCandidate[],
  today: string,
  evidence: readonly ResearchSourceItem[],
  allowedSymbols: readonly string[],
  recentCoverage: readonly RecentTickerCoverage[] = [],
): ResearchBrief['ideas'] {
  const minimum = addDays(today, 21)
  const maximum = addDays(today, 90)
  const symbols = new Set(allowedSymbols)
  const bound = ideas.flatMap((idea) => {
    if (!symbols.has(idea.symbol)) return []
    const selected = [...new Set(idea.sourceIndices)].map((index) => evidence[index])
    if (!selected.length || selected.some((source) => !source?.symbols?.includes(idea.symbol))) return []
    if ([idea.headline, idea.description, idea.risk].some(mentionsDiscoverySource)) return []
    if (!coverageReviewIsValid(idea, selected, recentCoverage)) return []
    const sources = [...new Map(selected.map((source) => {
      const link = evidenceSourceLink(source!)
      return [link.url, link]
    })).values()].slice(0, 3)
    const {
      recentCoverageIndices: _recentCoverageIndices,
      sourceIndices: _sourceIndices,
      thesisChange: _thesisChange,
      ...publicIdea
    } = idea
    const expiry = idea.play === null ? undefined : playExpiryDate(idea.play, today)
    const play = idea.play !== null && expiry !== undefined && expiry >= minimum && expiry <= maximum
      && isOptionExpirationDate(expiry) ? idea.play : null
    return [ResearchIdeaSchema.parse({ ...publicIdea, play, sources })]
  })
  const bySymbol = new Map<string, ResearchBrief['ideas'][number]>()
  for (const idea of bound) {
    const current = bySymbol.get(idea.symbol)
    if (!current || (current.play === null && idea.play !== null)) bySymbol.set(idea.symbol, idea)
  }
  return [...bySymbol.values()]
}

/** Bind the editor's ranked reading picks to application-owned evidence URLs. */
export function readingListFromCandidates(
  value: readonly ReadingLinkCandidate[],
  evidence: readonly ResearchSourceItem[],
): ResearchBrief['readingList'] {
  const accepted = new Map<string, ResearchBrief['readingList'][number]>()
  for (const candidate of value) {
    if (mentionsDiscoverySource(candidate.reason)) continue
    const source = evidence[candidate.sourceIndex]
    if (!source) continue
    const link = evidenceSourceLink(source)
    try {
      const url = new URL(link.url)
      if (url.hostname.toLowerCase().replace(/^www\./, '') === 'finance.yahoo.com'
        && url.pathname.startsWith('/quote/')) continue
    } catch {
      continue
    }
    if (accepted.has(link.url)) continue
    const title = (source.outbound?.label ?? source.title).slice(0, 180)
    const parsed = ResearchReadingLinkSchema.safeParse({ reason: candidate.reason, title, url: link.url })
    if (parsed.success) accepted.set(link.url, parsed.data)
    if (accepted.size === 10) break
  }
  return [...accepted.values()]
}

/**
 * Discovery providers shape private search scope but are never named in Daily Read
 * prose, and neither is the fact that public discussion shaped it at all. Naming the
 * venue generically ("chatter on the forum", "social media buzz") leaks the same thing
 * as naming the site, so both are rejected.
 *
 * Every pattern must stay narrow enough for ordinary market prose. Two deliberate
 * choices carry that: bare `X` is a word an editor writes for many reasons — and is a
 * real US ticker — so only the platform phrasings (`on X`, `X users`, `X posts`) match,
 * case-sensitively; and `forum` matches only in lower case, which keeps proper names
 * such as the World Economic Forum out. Rejection is cheap here (a generic title, or
 * one dropped idea) and a leak is not, but over-wide patterns silently empty the brief.
 */
const DISCOVERY_SOURCE_PATTERNS: readonly RegExp[] = [
  /\b(?:sub)?reddits?\b|wallstreetbets|\br\/[a-z0-9_]{2,}/i,
  /\btwitter\b|\bx\.com\b|\b(?:re)?tweet(?:ed|ing|s)?\b/i,
  /\bon X\b|\bX (?:users?|posts?|threads?|accounts?)\b/,
  /\bsocial media\b|\b(?:message|discussion|bulletin)[ -]boards?\b/i,
  /\bforums?\b/,
]

export function mentionsDiscoverySource(value: string): boolean {
  return DISCOVERY_SOURCE_PATTERNS.some((pattern) => pattern.test(value))
}

function redditPostId(url: string): string | undefined {
  try {
    return new URL(url).pathname.match(/\/comments\/([a-z0-9]+)(?:\/|$)/i)?.[1]?.toLowerCase()
  } catch {
    return undefined
  }
}

export function redditCatalystsFromCandidates(
  candidates: readonly RedditCatalystCandidate[],
  evidence: readonly ResearchSourceItem[],
  allowedSymbols: readonly string[],
  now = new Date(),
): Catalyst[] {
  const symbols = new Set(allowedSymbols.map((symbol) => symbol.toUpperCase()))
  const today = marketDate(now)
  const horizon = addDays(today, 180)
  const accepted = new Map<string, Catalyst>()
  for (const candidate of candidates) {
    const source = evidence[candidate.sourceIndex]
    const postId = source && source.source === REDDIT_RESEARCH_SOURCE ? redditPostId(source.url) : undefined
    if (!source || !postId || !source.symbols?.includes(candidate.symbol)
      || !symbols.has(candidate.symbol) || !isValidIsoDate(candidate.date)
      || candidate.date < today || candidate.date > horizon) continue
    const id = `reddit:${postId}:${candidate.symbol}:${candidate.kind}:${candidate.date}`
    accepted.set(id, CatalystSchema.parse({
      ...candidate,
      id,
      confidence: 'estimated',
      source: REDDIT_RESEARCH_SOURCE,
      sourceUrl: source.url,
      updatedAt: now.toISOString(),
    }))
  }
  return [...accepted.values()]
}

function evidenceSourceLink(source: ResearchSourceItem): ResearchBrief['sources'][number] {
  return source.outbound
    ? { label: source.outbound.label, url: source.outbound.url }
    : { label: `${source.source} · ${source.title}`, url: source.url }
}

/**
 * Headline used for a detected move whose editor explanation was absent or failed
 * deterministic binding. It is exported so the pipeline can count how many movers
 * fell back without re-deriving the string, and so tests pin the exact fallback.
 * A brief whose movers all carry this headline means the editor bound nothing.
 */
export const UNCONFIRMED_MOVER_HEADLINE = 'Move detected; driver not established'

export interface MarketMoverPacketRow {
  changePercent: number
  category: 'gainer' | 'loser' | 'most-active'
  evidenceIndices: number[]
  headlines: string[]
  name: string
  price: number
  symbol: string
}

/**
 * The editor's own section for detected movers. Mixed into the flat evidence list,
 * the mover task was free recall — find every mover, then find its rows — and a
 * production run bound one of six movers while on-point earnings articles for three
 * more sat in the packet. Each detected move is named once here with the exact
 * evidence indices that may be cited for it, which turns the task into a per-row
 * fill-in the prompt can require an answer for.
 *
 * The indices are positions in the same evidence array `marketMoverInsightsFromCandidates`
 * resolves against, so this changes only what the editor can find, never what binds:
 * a copied index still has to carry the candidate's own symbol.
 */
export function marketMoverPacket(evidence: readonly ResearchSourceItem[]): MarketMoverPacketRow[] {
  const rows = new Map<string, MarketMoverPacketRow>()
  evidence.forEach((item, index) => {
    const mover = item.marketMover
    if (!mover) return
    const row = rows.get(mover.symbol) ?? {
      changePercent: mover.changePercent,
      category: mover.category,
      evidenceIndices: [],
      headlines: [],
      name: mover.name,
      price: mover.price,
      symbol: mover.symbol,
    }
    row.evidenceIndices.push(index)
    row.headlines.push(item.outbound?.label ?? item.title)
    rows.set(mover.symbol, row)
  })
  return [...rows.values()]
}

/**
 * The editor explains possible drivers, but code supplies every move metric and
 * binds every citation to evidence for the same symbol. Missing/invalid editor
 * output becomes an explicit unconfirmed driver so detected moves still surface.
 */
export function marketMoverInsightsFromCandidates(
  candidates: readonly MarketMoverCandidate[],
  evidence: readonly ResearchSourceItem[],
): ResearchBrief['marketMovers'] {
  const moverEvidence = new Map<string, ResearchSourceItem[]>()
  for (const source of evidence) {
    const symbol = source.marketMover?.symbol
    if (symbol) moverEvidence.set(symbol, [...(moverEvidence.get(symbol) ?? []), source])
  }
  const insights = new Map<string, ResearchBrief['marketMovers'][number]>()

  for (const candidate of candidates) {
    if ([candidate.headline, candidate.description].some(mentionsDiscoverySource)) continue
    const sources = [...new Set(candidate.sourceIndices)].map((index) => evidence[index])
    if (sources.some((source) => source?.marketMover?.symbol !== candidate.symbol)) continue
    const metadata = sources[0]?.marketMover
    if (!metadata) continue
    const links = [...new Map(sources.map((source) => {
      const link = evidenceSourceLink(source!)
      return [link.url, link]
    })).values()].slice(0, 3)
    insights.set(candidate.symbol, MarketMoverInsightSchema.parse({
      ...metadata,
      description: candidate.description,
      headline: candidate.headline,
      sources: links,
    }))
  }

  for (const [symbol, sources] of moverEvidence) {
    if (insights.has(symbol)) continue
    const metadata = sources[0]?.marketMover
    if (!metadata) continue
    insights.set(symbol, MarketMoverInsightSchema.parse({
      ...metadata,
      description: `${metadata.name} moved ${metadata.changePercent >= 0 ? '+' : ''}${metadata.changePercent.toFixed(2)}% to $${metadata.price.toFixed(2)}. The reviewed evidence did not establish a sufficiently clear cause, so the driver remains unconfirmed.`,
      headline: UNCONFIRMED_MOVER_HEADLINE,
      sources: [evidenceSourceLink(sources[0]!)],
    }))
  }
  return [...insights.values()].slice(0, 6)
}
