import { z } from 'zod'

import { CatalystKindSchema, CatalystSchema, isValidIsoDate, marketDate, type Catalyst } from '../domain/catalyst'
import {
  EQUITY_SYMBOL_PATTERN,
  EquitySymbolSchema,
  POTENTIAL_PLAY_PATTERN,
  POTENTIAL_PLAY_REGEX,
} from '../domain/instrument'
import { JsonArraySchema, jsonObject, jsonObjectOrEmpty, type JsonValue } from '../domain/json-payload'
import { MarketMoverInsightSchema, ResearchIdeaSchema, type ResearchBrief } from '../domain/market'
import { type RecentTickerCoverage } from './research-coverage'
import { MAX_DAILY_RESEARCH_IDEAS, type ResearchSourceItem } from './research-contracts'
import { REDDIT_RESEARCH_SOURCE } from './research-reddit'

const GeneratedRedditCatalystSchema = z.object({
  sourceIndex: z.number().int().nonnegative(),
  symbol: EquitySymbolSchema,
  kind: CatalystKindSchema.exclude(['earnings']),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(500),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timing: z.enum(['pre-market', 'intraday', 'after-hours', 'unknown']),
})

const GeneratedMarketMoverInsightSchema = z.object({
  description: z.string().trim().min(1).max(360),
  headline: z.string().trim().min(1).max(100),
  sourceIndices: z.array(z.number().int().nonnegative()).min(1).max(3),
  symbol: EquitySymbolSchema,
})

const GeneratedResearchIdeaSchema = z.object({
  description: z.string().trim().min(1).max(360),
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  headline: z.string().trim().min(1).max(100),
  play: z.string().trim().max(40).regex(POTENTIAL_PLAY_REGEX),
  recentCoverageIndices: z.array(z.number().int().nonnegative()).max(3),
  risk: z.string().trim().min(1).max(240),
  sourceIndices: z.array(z.number().int().nonnegative()).min(1).max(3),
  symbol: EquitySymbolSchema,
  thesisChange: z.string().trim().max(240),
}).refine((idea) => idea.play.startsWith(`${idea.symbol} `), {
  message: 'Potential play must use the idea symbol',
  path: ['play'],
})

const GeneratedResearchSchema = z.object({
  title: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(360),
  regime: z.string().trim().min(1).max(80),
  regimeDetail: z.string().trim().min(1).max(180),
  // Stored briefs retain the historical max of five; new issues deliberately
  // narrow the editor to the highest-quality zero-to-three theses.
  ideas: z.array(GeneratedResearchIdeaSchema).max(MAX_DAILY_RESEARCH_IDEAS),
  marketMovers: z.array(GeneratedMarketMoverInsightSchema).max(6),
})

const GeneratedRedditCatalystResponseSchema = z.object({
  catalysts: z.array(GeneratedRedditCatalystSchema).max(20),
})

export type GeneratedResearch = z.infer<typeof GeneratedResearchSchema>

/** Model output text is compared verbatim, so it is never trimmed on the way in. */
const ModelTextSchema = z.string()

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10)
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

function normalizedThesis(headline: string, description: string): string {
  return `${headline} ${description}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function coverageReviewIsValid(
  idea: GeneratedResearch['ideas'][number],
  selectedEvidence: readonly (ResearchSourceItem | undefined)[],
  recentCoverage: readonly RecentTickerCoverage[],
): boolean {
  const expectedIndices = recentCoverage.flatMap((coverage, index) => (
    coverage.symbol === idea.symbol ? [index] : []
  ))
  const reviewedIndices = [...new Set(idea.recentCoverageIndices)]
  if (!expectedIndices.length) return !reviewedIndices.length && !idea.thesisChange
  if (!idea.thesisChange || reviewedIndices.length !== expectedIndices.length
    || reviewedIndices.some((index) => !expectedIndices.includes(index))) return false

  const latestPriorCoverage = Math.max(...expectedIndices.map((index) => (
    Date.parse(recentCoverage[index]!.publishedAt)
  )))
  if (!selectedEvidence.some((source) => (
    source?.publishedAt !== undefined && Date.parse(source.publishedAt) > latestPriorCoverage
  ))) return false

  const currentThesis = normalizedThesis(idea.headline, idea.description)
  return expectedIndices.every((index) => {
    const prior = recentCoverage[index]!
    return normalizedThesis(prior.headline, prior.description) !== currentThesis
  })
}

/**
 * Enforce the prompt's expiry horizon in code; a valid-looking model date can still be
 * impossible, stale, or a calendar day on which no option expires.
 */
export function researchIdeasForDate(
  ideas: readonly GeneratedResearch['ideas'][number][],
  today: string,
  evidence: readonly ResearchSourceItem[],
  allowedSymbols: readonly string[],
  recentCoverage: readonly RecentTickerCoverage[] = [],
): ResearchBrief['ideas'] {
  const minimum = addDays(today, 21)
  const maximum = addDays(today, 90)
  const symbols = new Set(allowedSymbols)
  return ideas.flatMap((idea) => {
    const expiry = playExpiryDate(idea.play, today)
    if (!symbols.has(idea.symbol) || expiry === undefined || expiry < minimum || expiry > maximum
      || !isOptionExpirationDate(expiry)) return []
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
    return [ResearchIdeaSchema.parse({ ...publicIdea, sources })]
  })
}

/** Discovery providers shape private search scope but are never named in Daily Read prose. */
export function mentionsDiscoverySource(value: string): boolean {
  return /\breddit\b|wallstreetbets|r\/wallstreetbets/i.test(value)
}

function extractJson(response: string): JsonValue {
  const fenced = response.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  return JSON.parse(fenced ?? response)
}

function modelOutputText(payload: JsonValue): string | undefined {
  const body = jsonObjectOrEmpty(payload)
  const direct = ModelTextSchema.safeParse(body.output_text ?? body.response).data
  if (direct !== undefined) return direct
  if (jsonObject(body.response)) return JSON.stringify(body.response)

  for (const choice of (JsonArraySchema.safeParse(body.choices).data ?? []).map(jsonObjectOrEmpty)) {
    const content = ModelTextSchema.safeParse(jsonObjectOrEmpty(choice.message).content).data
    if (content !== undefined) return content
  }
  for (const item of (JsonArraySchema.safeParse(body.output).data ?? []).map(jsonObjectOrEmpty)) {
    for (const content of (JsonArraySchema.safeParse(item.content).data ?? []).map(jsonObjectOrEmpty)) {
      const text = ModelTextSchema.safeParse(content.text).data
      if (content.type === 'output_text' && text !== undefined) return text
    }
  }
  return undefined
}

function normalizeDirection(value: JsonValue): JsonValue {
  const raw = ModelTextSchema.safeParse(value).data
  if (raw === undefined) return value
  const direction = raw.toLowerCase()
  if (direction.includes('bull') || direction.includes('upside') || direction === 'positive') return 'bullish'
  if (direction.includes('bear') || direction.includes('downside') || direction === 'negative') return 'bearish'
  if (direction.includes('neutral') || direction.includes('range') || direction.includes('mixed') || direction.includes('wait')) return 'neutral'
  return direction
}

function normalizeModelResearch(value: JsonValue): JsonValue {
  const research = jsonObject(value)
  const ideas = research && JsonArraySchema.safeParse(research.ideas).data
  if (!research || !ideas) return value
  return {
    ...research,
    ideas: ideas.map((idea) => {
      const fields = jsonObject(idea)
      return fields ? { ...fields, direction: normalizeDirection(fields.direction) } : idea
    }),
  }
}

export function parseGeneratedResearch(payload: JsonValue): GeneratedResearch {
  return GeneratedResearchSchema.parse(
    normalizeModelResearch(extractJson(modelOutputText(payload) ?? '')),
  )
}

export function parseGeneratedRedditCatalysts(payload: JsonValue): JsonValue {
  return GeneratedRedditCatalystResponseSchema.parse(
    extractJson(modelOutputText(payload) ?? ''),
  ).catalysts
}

export function dailyResearchResponseSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: ['title', 'summary', 'regime', 'regimeDetail', 'ideas', 'marketMovers'],
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 100 },
      summary: { type: 'string', minLength: 1, maxLength: 360 },
      regime: { type: 'string', minLength: 1, maxLength: 80 },
      regimeDetail: { type: 'string', minLength: 1, maxLength: 180 },
      ideas: {
        type: 'array', maxItems: MAX_DAILY_RESEARCH_IDEAS,
        items: {
          type: 'object', additionalProperties: false,
          required: ['symbol', 'direction', 'headline', 'description', 'play', 'risk', 'sourceIndices', 'recentCoverageIndices', 'thesisChange'],
          properties: {
            symbol: { type: 'string', pattern: EQUITY_SYMBOL_PATTERN },
            direction: { type: 'string', enum: ['bullish', 'bearish', 'neutral'] },
            headline: { type: 'string', minLength: 1, maxLength: 100 },
            description: { type: 'string', minLength: 1, maxLength: 360 },
            play: { type: 'string', pattern: POTENTIAL_PLAY_PATTERN },
            recentCoverageIndices: {
              type: 'array', maxItems: 3,
              items: { type: 'integer', minimum: 0 },
            },
            risk: { type: 'string', minLength: 1, maxLength: 240 },
            sourceIndices: {
              type: 'array', minItems: 1, maxItems: 3,
              items: { type: 'integer', minimum: 0 },
            },
            thesisChange: { type: 'string', maxLength: 240 },
          },
        },
      },
      marketMovers: {
        type: 'array', maxItems: 6,
        items: {
          type: 'object', additionalProperties: false,
          required: ['symbol', 'sourceIndices', 'headline', 'description'],
          properties: {
            symbol: { type: 'string', pattern: EQUITY_SYMBOL_PATTERN },
            sourceIndices: {
              // Workers AI's structured-output grammar does not implement uniqueItems.
              // The deterministic binder below removes duplicate indices before use.
              type: 'array', minItems: 1, maxItems: 3,
              items: { type: 'integer', minimum: 0 },
            },
            headline: { type: 'string', minLength: 1, maxLength: 100 },
            description: { type: 'string', minLength: 1, maxLength: 360 },
          },
        },
      },
    },
  }
}

export function redditCatalystResponseSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: ['catalysts'],
    properties: {
      catalysts: {
        type: 'array', maxItems: 20,
        items: {
          type: 'object', additionalProperties: false,
          required: ['sourceIndex', 'symbol', 'kind', 'title', 'description', 'date', 'timing'],
          properties: {
            sourceIndex: { type: 'integer', minimum: 0 },
            symbol: { type: 'string', pattern: EQUITY_SYMBOL_PATTERN },
            kind: { type: 'string', enum: ['investor-event', 'product-event', 'regulatory', 'clinical', 'conference', 'shareholder'] },
            title: { type: 'string', minLength: 1, maxLength: 160 },
            description: { type: 'string', minLength: 1, maxLength: 500 },
            date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            timing: { type: 'string', enum: ['pre-market', 'intraday', 'after-hours', 'unknown'] },
          },
        },
      },
    },
  }
}

function redditPostId(url: string): string | undefined {
  try {
    return new URL(url).pathname.match(/\/comments\/([a-z0-9]+)(?:\/|$)/i)?.[1]?.toLowerCase()
  } catch {
    return undefined
  }
}

/** Bind model candidates to a watched symbol and the exact same-symbol Reddit post selected by code. */
export function redditCatalystsFromCandidates(
  value: JsonValue,
  evidence: readonly ResearchSourceItem[],
  allowedSymbols: readonly string[],
  now = new Date(),
): Catalyst[] {
  const candidates = z.array(GeneratedRedditCatalystSchema).max(20).parse(value)
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

/** Cite the fetched article when it supplied the evidence, not its aggregator row. */
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

/**
 * The editor explains possible drivers, but code supplies every move metric and
 * binds every citation to evidence for the same symbol. Missing/invalid editor
 * output becomes an explicit unconfirmed driver so detected moves still surface.
 */
export function marketMoverInsightsFromCandidates(
  value: JsonValue,
  evidence: readonly ResearchSourceItem[],
): ResearchBrief['marketMovers'] {
  const candidates = z.array(GeneratedMarketMoverInsightSchema).max(6).parse(value)
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
