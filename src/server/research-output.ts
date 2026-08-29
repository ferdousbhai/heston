import { isValidIsoDate } from '../domain/catalyst'
import {
  ResearchIdeaSchema,
  ResearchReadingLinkSchema,
  type ResearchBrief,
} from '../domain/market'
import { type DailyResearchSubmission } from './research-agent'
import { type EquityOptionTuple } from './option-contract'
import { type ResearchSourceItem } from './research-contracts'

type ResearchIdeaCandidate = DailyResearchSubmission['ideas'][number]
type ReadingLinkCandidate = DailyResearchSubmission['readingList'][number]

const SOCIAL_SOURCE_HOSTS = [
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'reddit.com',
  'redd.it',
  'tiktok.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'youtu.be',
]

/** Discovery can begin socially, but public citations must resolve to source material. */
export function isPublicResearchSource(value: string): boolean {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !SOCIAL_SOURCE_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))
      && !(host === 'finance.yahoo.com' && url.pathname.startsWith('/quote/'))
  } catch {
    return false
  }
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

/** Bind evidence and option shape, then leave contract existence to the chain. */
export function researchIdeas(
  ideas: readonly ResearchIdeaCandidate[],
  evidence: readonly ResearchSourceItem[],
  allowedSymbols: readonly string[],
): BoundResearchIdea[] {
  const symbols = new Set(allowedSymbols)
  const bound = ideas.flatMap((idea) => {
    if (!symbols.has(idea.symbol)) return []
    const selected = [...new Set(idea.sourceIndices)].map((index) => evidence[index])
    if (!selected.length || selected.some((source) => !source?.symbols?.includes(idea.symbol))) return []
    if ([idea.headline, idea.description, idea.risk].some(mentionsDiscoverySource)) return []
    const sources = [...new Map(selected.map((source) => {
      const link = evidenceSourceLink(source!)
      return [link.url, link]
    })).values()].slice(0, 3)
    const {
      sourceIndices: _sourceIndices,
      ...publicIdea
    } = idea
    const contract = idea.play !== null && isValidIsoDate(idea.play.expiration)
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
    if (mentionsDiscoverySource(candidate.title) || mentionsDiscoverySource(candidate.description)) continue
    const source = evidence[candidate.sourceIndex]
    if (!source) continue
    const link = evidenceSourceLink(source)
    if (!isPublicResearchSource(link.url)) continue
    if (accepted.has(link.url)) continue
    const parsed = ResearchReadingLinkSchema.safeParse({
      reason: candidate.description,
      title: candidate.title,
      url: link.url,
    })
    if (parsed.success) accepted.set(link.url, parsed.data)
    if (accepted.size === 6) break
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

function evidenceSourceLink(source: ResearchSourceItem): ResearchBrief['sources'][number] {
  return source.outbound
    ? { label: source.outbound.label, url: source.outbound.url }
    : { label: `${source.source} · ${source.title}`, url: source.url }
}
