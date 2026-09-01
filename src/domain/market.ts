import { z } from 'zod'

import { CatalystSchema } from './catalyst'
import { CandlePointSchema, MAX_YEAR_CANDLES } from './candle'
import { EquitySymbolSchema } from './instrument'
import { isValidIsoDate } from './iso-date'
import { type JsonValue } from './json-payload'
import {
  RecommendedOrderSchema,
  recommendedOrderIssues,
} from './recommended-order'

// One list, two audiences: `private` is the owner's authoritative D1 internal
// watchlist, `public` its published projection. The kind still gates the manage
// button and every mutation, so audience separation survives the single-list shape.
const WatchlistKindSchema = z.enum(['private', 'public'])

export const WatchlistSchema = z.object({
  id: z.string(),
  kind: WatchlistKindSchema,
  name: z.string(),
  symbols: z.array(EquitySymbolSchema),
})

const MarketDateSchema = z.string().refine(isValidIsoDate, 'Use a real YYYY-MM-DD date')

const IvTermStructureSchema = z.object({
  backExpiration: MarketDateSchema,
  backIv: z.number().min(0),
  frontExpiration: MarketDateSchema,
  frontIv: z.number().min(0),
})

export const TickerSchema = z.object({
  symbol: EquitySymbolSchema,
  name: z.string(),
  assetType: z.enum(['stock', 'etf', 'index']).optional(),
  /* tastytrade quotes an annual borrow rate, but it is 0 for all but one easy-to-borrow
     name and repeats what lendability reports, so the ticker carries lendability alone.
     The instrument catalog still stores the provider's rate. */
  lendability: z.string().optional(),
  marketCap: z.number().nonnegative().optional(),
  price: z.number(),
  change: z.number(),
  changePercent: z.number(),
  // REST quotes do not contain candle history. Keep this empty until real DXLink
  // candles arrive instead of drawing a synthetic move from previous close.
  sparkline: z.array(CandlePointSchema),
  // A year of daily closes, cached rather than streamed: it changes once a session, so it
  // rides the snapshot. Absent until the refresh has run for this symbol.
  yearCloses: z.array(CandlePointSchema).max(MAX_YEAR_CANDLES).optional(),
  ivRank: z.number().optional(),
  ivPercentile: z.number().optional(),
  ivIndex: z.number().optional(),
  ivIndex5DayChange: z.number().optional(),
  historicalVolatility30Day: z.number().min(0).optional(),
  ivHistoricalVolatility30DayDifference: z.number().optional(),
  ivTermStructure: IvTermStructureSchema.optional(),
  liquidity: z.number().optional(),
  volume: z.number().nonnegative().optional(),
  yearHigh: z.number().positive().optional(),
  yearLow: z.number().positive().optional(),
  earningsDate: z.string().nullable(),
  position: z.boolean(),
  updatedAt: z.string(),
})

/** The public wire contract cannot represent account-derived position membership. */
export const PublicTickerSchema = TickerSchema.omit({ position: true }).strict()

const RecommendationFields = {
  symbol: EquitySymbolSchema,
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  headline: z.string().min(1).max(100),
  description: z.string().min(1).max(360),
  risk: z.string().min(1).max(240),
}

const ResearchSourceLinkSchema = z.object({
  label: z.string(),
  // Stored recommendations predate the current evidence binder. Only web citations may
  // cross that persistence boundary into owner or public anchor elements.
  url: z.string().url().refine((url) => new URL(url).protocol === 'https:', 'Use an HTTPS source URL'),
})

export const RecommendationSchema = z.object({
  ...RecommendationFields,
  recommendedOrder: RecommendedOrderSchema,
  sources: z.array(ResearchSourceLinkSchema),
}).superRefine((recommendation, context) => {
  if (recommendation.recommendedOrder.kind === 'legacy-unstructured') return
  for (const message of recommendedOrderIssues(
    recommendation.recommendedOrder,
    recommendation.symbol,
    recommendation.direction,
  )) {
    context.addIssue({ code: 'custom', message, path: ['recommendedOrder'] })
  }
})

export const RecommendationLinkSchema = z.object({
  description: z.string().min(1).max(180),
  previewImageUrl: z.string().url()
    .refine((url) => new URL(url).protocol === 'https:', 'Use an HTTPS preview image URL')
    .optional(),
  title: z.string().min(1).max(180),
  url: z.string().url().refine((url) => new URL(url).protocol === 'https:', 'Use an HTTPS source URL'),
})

export const DailyRecommendationsSchema = z.object({
  id: z.string(),
  publishedAt: z.string(),
  title: z.string(),
  summary: z.string(),
  regime: z.string(),
  regimeDetail: z.string(),
  recommendations: z.array(RecommendationSchema),
  links: z.array(RecommendationLinkSchema),
  sources: z.array(ResearchSourceLinkSchema),
})

/** D1 stores the current public recommendation contract; incompatible rows fail visibly. */
export function parseStoredDailyRecommendations(value: JsonValue): DailyRecommendations {
  return DailyRecommendationsSchema.parse(value)
}

export const MarketStateSchema = z.enum(['open', 'closed', 'pre', 'after', 'unknown'])

export type MarketState = z.infer<typeof MarketStateSchema>

export const MarketSnapshotSchema = z.object({
  source: z.literal('tastytrade'),
  syncedAt: z.string(),
  marketState: MarketStateSchema,
  // Present when the provider named an opening bell for the current session; a reader waiting
  // through pre-market is counting down to this.
  marketOpensAt: z.string().optional(),
  watchlists: z.array(WatchlistSchema).length(1),
  tickers: z.array(TickerSchema),
  catalysts: z.array(CatalystSchema),
  recommendations: DailyRecommendationsSchema.optional(),
})

const PublicWatchlistSchema = WatchlistSchema.extend({ kind: z.literal('public') }).strict()

export const PublicMarketSnapshotSchema = z.strictObject({
  source: z.literal('tastytrade'),
  syncedAt: z.string(),
  marketState: MarketStateSchema,
  // Present when the provider named an opening bell for the current session; a reader waiting
  // through pre-market is counting down to this.
  marketOpensAt: z.string().optional(),
  watchlists: z.array(PublicWatchlistSchema).length(1),
  tickers: z.array(PublicTickerSchema),
  catalysts: z.array(CatalystSchema),
  recommendations: DailyRecommendationsSchema.optional(),
})

/**
 * One symbol the loaded watchlist did not carry, resolved on demand. It arrives with the
 * same rows a snapshot ticker has, so the market table renders it as an ordinary row
 * rather than as a second kind of thing. `watchlisted` reports whether the maintained
 * list kept it, which is what decides if it is still here on the next snapshot.
 */
export const PublicSymbolLookupSchema = z.strictObject({
  catalysts: z.array(CatalystSchema),
  ticker: PublicTickerSchema,
  watchlisted: z.boolean(),
})

export type PublicSymbolLookup = z.infer<typeof PublicSymbolLookupSchema>

export type Watchlist = z.infer<typeof WatchlistSchema>
export type Ticker = z.infer<typeof TickerSchema>
export type IvTermStructure = z.infer<typeof IvTermStructureSchema>
export type DailyRecommendations = z.infer<typeof DailyRecommendationsSchema>
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>
export type PublicMarketSnapshot = z.infer<typeof PublicMarketSnapshotSchema>
export type PublicTicker = z.infer<typeof PublicTickerSchema>

export function publicTickerFromTicker(ticker: Ticker): PublicTicker {
  const { position: _privatePosition, ...candidate } = ticker
  return PublicTickerSchema.parse(candidate)
}

/** Convert a validated account-free response into the browser's richer internal model. */
export function marketSnapshotFromPublic(snapshot: PublicMarketSnapshot): MarketSnapshot {
  return MarketSnapshotSchema.parse({
    ...snapshot,
    tickers: snapshot.tickers.map((ticker) => ({ ...ticker, position: false })),
  })
}

/** Highest reported share volume first; missing volume sorts last, then ticker. */
export function mostActiveSymbol(
  tickers: readonly Ticker[],
  watchlistSymbols: readonly string[] = [],
): string | undefined {
  const watchlist = new Set(watchlistSymbols)
  const watchlistTickers = watchlist.size
    ? tickers.filter((ticker) => watchlist.has(ticker.symbol))
    : []
  const candidates = watchlistTickers.length ? watchlistTickers : tickers
  return [...candidates].sort((left, right) => {
    if (left.volume === undefined || right.volume === undefined) {
      const missingOrder = Number(left.volume === undefined) - Number(right.volume === undefined)
      if (missingOrder) return missingOrder
    } else if (left.volume !== right.volume) {
      return right.volume - left.volume
    }
    return left.symbol.localeCompare(right.symbol)
  })[0]?.symbol
}

export type VolatilityVerdict = 'cheap' | 'fair' | 'rich' | 'unavailable'

const marketMetricFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

export function formatMarketMetric(value: number): string {
  return marketMetricFormatter.format(value)
}

const marketPriceFormatter = new Intl.NumberFormat('en-US', {
  currency: 'USD',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: 'currency',
})

export function formatMarketPrice(value: number): string {
  return marketPriceFormatter.format(value)
}

export function fiftyTwoWeekPosition(
  ticker: Pick<Ticker, 'price' | 'yearHigh' | 'yearLow'>,
): number | undefined {
  if (ticker.yearLow === undefined || ticker.yearHigh === undefined || ticker.yearHigh <= ticker.yearLow) {
    return undefined
  }
  return Math.min(100, Math.max(0, ((ticker.price - ticker.yearLow) / (ticker.yearHigh - ticker.yearLow)) * 100))
}

export function volatilityVerdict(ticker: Pick<Ticker, 'ivRank' | 'ivPercentile'>): VolatilityVerdict {
  if (ticker.ivRank === undefined || ticker.ivPercentile === undefined) return 'unavailable'
  if (ticker.ivRank <= 30 && ticker.ivPercentile <= 35) return 'cheap'
  if (ticker.ivRank >= 70 || ticker.ivPercentile >= 80) return 'rich'
  return 'fair'
}

/** One sign convention for the tape label: positive means front over back. */
export function termStructureSpread(term: IvTermStructure): number {
  return term.frontIv - term.backIv
}

const CLASS_NOUN = String.raw`(?:Common|Capital|Preferred|Ordinary|Beneficial|Subordinate|Voting|Registered|Registry|Deposit[ao]ry|Units?|Shares?|Stock|Interests?)`

/*
 * The class tail as tastytrade writes it, in every spelling its descriptions use: joined by
 * a hyphen or nothing ("NVIDIA Corporation - Common Stock", "Ford Motor Company Common
 * Stock"), led by a share class ("Dell Technologies Inc. Class C Common Stock"), or running
 * into prose ("NIO Inc. American depositary shares, each representing one Class A ordinary
 * share"). A class is only read as one when a class noun follows, so the "Series B" of an
 * ETN and the "Shares" of SPDR Gold Shares stay part of the issuer's own name.
 */
const SECURITY_CLASS = new RegExp([
  String.raw`\b(?:Class|Series) [A-Z]\b(?= ${CLASS_NOUN})`,
  String.raw`\b(?:Common|Capital|Preferred|Beneficial) Stock\b`,
  String.raw`\b(?:Common|Ordinary|Ord|Subordinate Voting) Shares?\b`,
  String.raw`\b(?:New York )?(?:Registry|Registered) Shares?\b`,
  String.raw`\b(?:Common|Deposit[ao]ry) Units\b`,
  String.raw`\b(?:Shares|Units) of Beneficial Interest\b`,
  String.raw`\b(?:Sponsored )?(?:American )?Deposit[ao]ry Shares?\b`,
  String.raw`\bADSs?\b`,
  String.raw`\bADRs?\b`,
].join('|'), 'gi')

/* Some rows lead with the abbreviated name the tape carries: "CAREVIEW COMMUNS INC by
   Careview Communications, Inc.". The shouting is what tells this apart from an issuer
   whose own name contains "by" (Natural Grocers by Vitamin Cottage). */
const TAPE_ABBREVIATION = /^[A-Z0-9][A-Z0-9 .,&/()-]* by (?=\S)/

/* A description shouted end to end is a tape string, and abbreviates the class it appends
   ("CATALENT INC COM", "GORES HLD XI CL A OS"). Only these rows are read this way, so an
   issuer that merely ends in one of these letters keeps its name. */
const TAPE_CLASS = /(?: (?:COM|CM|CS|SHS|ORD|ORDA|CLA|OS|NEW|CL [A-Z]|SH [A-Z]|ORD [A-Z]))+$/

/**
 * The issuer as the list should read it. The security class repeats down every row and
 * tells no two apart, and neither does a trailing qualifier ("(The)", "(DE)", "(REIT)"),
 * so both are cut. A description that carries no class tail — a fund, a trust, an issuer
 * whose name is a marker itself — is returned whole.
 */
export function issuerName(name: string): string {
  const described = name.replace(TAPE_ABBREVIATION, '')
  // A marker at the very start is the issuer's own name (ADS-TEC ENERGY PLC), not its class.
  const tail = [...described.matchAll(SECURITY_CLASS)].find((match) => match.index > 0)
  const issuer = (tail ? described.slice(0, tail.index) : described)
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/[\s,\u2013-]+$/, '')
  const named = issuer === issuer.toUpperCase() ? issuer.replace(TAPE_CLASS, '') : issuer
  return named || described
}
