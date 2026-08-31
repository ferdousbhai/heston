import { z } from 'zod'

import { CatalystSchema } from './catalyst'
import { CandlePointSchema } from './candle'
import { EquitySymbolSchema } from './instrument'
import { isValidIsoDate } from './iso-date'
import { type JsonValue } from './json-payload'

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

// Daily research has already validated the structured play before rendering this label.
// Reinterpreting the label here would create a second model-output policy.
const PotentialPlaySchema = z.string()

const ResearchIdeaFields = {
  symbol: EquitySymbolSchema,
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  headline: z.string().min(1).max(100),
  description: z.string().min(1).max(360),
  risk: z.string().min(1).max(240),
}

const ResearchSourceLinkSchema = z.object({
  label: z.string(),
  // Stored briefs predate the current evidence binder. Only web citations may
  // cross that persistence boundary into owner or public anchor elements.
  url: z.string().url().refine((url) => new URL(url).protocol === 'https:', 'Use an HTTPS source URL'),
})

export const ResearchIdeaSchema = z.object({
  ...ResearchIdeaFields,
  play: PotentialPlaySchema.nullable(),
  sources: z.array(ResearchSourceLinkSchema),
})

export const ResearchReadingLinkSchema = z.object({
  reason: z.string().min(1).max(180),
  title: z.string().min(1).max(180),
  url: z.string().url().refine((url) => new URL(url).protocol === 'https:', 'Use an HTTPS source URL'),
})

export const ResearchBriefSchema = z.object({
  id: z.string(),
  publishedAt: z.string(),
  title: z.string(),
  summary: z.string(),
  regime: z.string(),
  regimeDetail: z.string(),
  ideas: z.array(ResearchIdeaSchema),
  readingList: z.array(ResearchReadingLinkSchema),
  sources: z.array(ResearchSourceLinkSchema),
})

/** D1 stores the current public research contract; incompatible rows fail visibly. */
export function parseStoredResearchBrief(value: JsonValue): ResearchBrief {
  return ResearchBriefSchema.parse(value)
}

export const MarketSnapshotSchema = z.object({
  source: z.literal('tastytrade'),
  syncedAt: z.string(),
  marketState: z.enum(['open', 'closed', 'pre', 'after', 'unknown']),
  watchlists: z.array(WatchlistSchema).length(1),
  tickers: z.array(TickerSchema),
  catalysts: z.array(CatalystSchema),
  research: ResearchBriefSchema.optional(),
})

const PublicWatchlistSchema = WatchlistSchema.extend({ kind: z.literal('public') }).strict()

export const PublicMarketSnapshotSchema = z.strictObject({
  source: z.literal('tastytrade'),
  syncedAt: z.string(),
  marketState: z.enum(['open', 'closed', 'pre', 'after', 'unknown']),
  watchlists: z.array(PublicWatchlistSchema).length(1),
  tickers: z.array(PublicTickerSchema),
  catalysts: z.array(CatalystSchema),
  research: ResearchBriefSchema.optional(),
})

export type Watchlist = z.infer<typeof WatchlistSchema>
export type Ticker = z.infer<typeof TickerSchema>
export type IvTermStructure = z.infer<typeof IvTermStructureSchema>
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>
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

/*
 * Provider names carry the security class after a spaced hyphen ("NVIDIA Corporation -
 * Common Stock"); the class repeats across the list, so only the issuer is displayed.
 */
export function issuerName(name: string): string {
  return name.split(' - ')[0] ?? name
}

