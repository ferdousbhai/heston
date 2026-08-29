import { CatalystSchema, isValidIsoDate, marketDate, type Catalyst } from '../domain/catalyst'
import {
  MarketMoverInsightSchema,
  ResearchIdeaSchema,
  ResearchReadingLinkSchema,
  type ResearchBrief,
} from '../domain/market'
import { type DailyResearchSubmission } from './research-agent'
import { type EquityOptionTuple } from './option-contract'
import { type RecentTickerCoverage } from './research-coverage'
import { addDays, type ResearchSourceItem } from './research-contracts'
import { REDDIT_RESEARCH_SOURCE } from './research-reddit'

type ResearchIdeaCandidate = DailyResearchSubmission['ideas'][number]
type ReadingLinkCandidate = DailyResearchSubmission['readingList'][number]
type MarketMoverCandidate = DailyResearchSubmission['marketMovers'][number]
type RedditCatalystCandidate = Omit<DailyResearchSubmission['redditCatalysts'][number], 'redditEvidenceIndex'> & {
  sourceIndex: number
}

export interface BoundResearchIdea {
  contract: EquityOptionTuple | null
  idea: ResearchBrief['ideas'][number]
}

function playLabel(play: EquityOptionTuple): string {
  const [, month, day] = play.expiry.split('-').map(Number)
  const optionType = play.optionType === 'C' ? 'c' : 'p'
  return `${play.underlying} ${play.strike}${optionType} ${month}/${day}`
}

function normalizedThesis(headline: string, description: string): string {
  return `${headline} ${description}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function coverageReviewIsValid(
  idea: ResearchIdeaCandidate,
  recentCoverage: readonly RecentTickerCoverage[],
): boolean {
  const previous = recentCoverage.filter((coverage) => coverage.symbol === idea.symbol)
  if (!previous.length) return !idea.thesisChange

  // The agent receives the dated prior rows and must find newer evidence. Native search
  // citations do not expose a trusted publication timestamp, so code can enforce only
  // the cross-row semantics: same-direction refresh or a genuinely changed thesis.
  if (!idea.thesisChange) {
    return previous.every((coverage) => coverage.direction === idea.direction)
  }
  const currentThesis = normalizedThesis(idea.headline, idea.description)
  return previous.every((coverage) => normalizedThesis(
    coverage.headline,
    coverage.description,
  ) !== currentThesis)
}

/** Bind cross-field evidence and coverage semantics, then leave contract existence to the chain. */
export function researchIdeasForDate(
  ideas: readonly ResearchIdeaCandidate[],
  today: string,
  evidence: readonly ResearchSourceItem[],
  allowedSymbols: readonly string[],
  recentCoverage: readonly RecentTickerCoverage[] = [],
): BoundResearchIdea[] {
  const minimum = addDays(today, 21)
  const maximum = addDays(today, 90)
  const symbols = new Set(allowedSymbols)
  const bound = ideas.flatMap((idea) => {
    if (!symbols.has(idea.symbol)) return []
    const selected = [...new Set(idea.sourceIndices)].map((index) => evidence[index])
    if (!selected.length || selected.some((source) => !source?.symbols?.includes(idea.symbol))) return []
    if ([idea.headline, idea.description, idea.risk].some(mentionsDiscoverySource)) return []
    if (!coverageReviewIsValid(idea, recentCoverage)) return []
    const sources = [...new Map(selected.map((source) => {
      const link = evidenceSourceLink(source!)
      return [link.url, link]
    })).values()].slice(0, 3)
    const {
      sourceIndices: _sourceIndices,
      thesisChange: _thesisChange,
      ...publicIdea
    } = idea
    const contract = idea.play !== null && isValidIsoDate(idea.play.expiration)
      && idea.play.expiration >= minimum
      && idea.play.expiration <= maximum
      ? {
          expiry: idea.play.expiration,
          optionType: idea.play.optionType === 'call' ? 'C' as const : 'P' as const,
          strike: idea.play.strike,
          underlying: idea.symbol,
        }
      : null
    return [{ contract, idea: ResearchIdeaSchema.parse({
      ...publicIdea,
      play: contract ? playLabel(contract) : null,
      sources,
    }) }]
  })
  const bySymbol = new Map<string, BoundResearchIdea>()
  for (const candidate of bound) {
    const current = bySymbol.get(candidate.idea.symbol)
    if (!current || (current.contract === null && candidate.contract !== null)) {
      bySymbol.set(candidate.idea.symbol, candidate)
    }
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
