import { z } from 'zod'

import { CatalystSchema, isValidIsoDate } from './catalyst'
import { CandlePointSchema } from './candle'
import { EquitySymbolSchema } from './instrument'
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
  borrowRate: z.number().optional(),
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
  research: ResearchBriefSchema,
})

export type Watchlist = z.infer<typeof WatchlistSchema>
export type Ticker = z.infer<typeof TickerSchema>
export type IvTermStructure = z.infer<typeof IvTermStructureSchema>
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>

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

export type InstrumentSignal = {
  detail: string
  key: 'day-move' | 'iv-vs-hv' | 'iv-5-day' | 'term-structure' | 'liquidity' | 'borrow' | 'range-edge'
  label: string
  tone: 'cheap' | 'rich' | 'note'
}

/**
 * These bands are trading heuristics, not statistical claims: a 4% day merits
 * explanation, ten IV points over realized or five points in a week marks clear
 * repricing, three term points suggests an event premium, liquidity at two and
 * borrow at 5% add execution friction, and the outer range decile marks an edge.
 * tastytrade quotes easy-to-borrow names at up to 1.5% a year, so a 1% band would
 * flag most of the list; 5% is where locate-required names begin.
 */
const SIGNAL_BANDS = {
  borrowRatePercent: 5,
  dayMovePercent: 4,
  ivFiveDayPoints: 5,
  ivOverHvPoints: 10,
  rangeEdgePercent: 10,
  termSpreadPoints: 3,
  thinLiquidityScore: 2,
}

function formatSignalPoints(value: number): string {
  const magnitude = formatMarketMetric(Math.abs(value))
  return `${magnitude} pt${magnitude === '1' ? '' : 's'}`
}

/** One sign convention for both the tape label and the signal: positive means front over back. */
export function termStructureSpread(term: IvTermStructure): number {
  return term.frontIv - term.backIv
}

/**
 * A reported rate settles the question on its own, so a rate inside the band
 * suppresses the coarser lendability label rather than letting it flag anyway.
 */
function borrowFrictionDetail(ticker: Pick<Ticker, 'borrowRate' | 'lendability'>): string | undefined {
  if (ticker.borrowRate !== undefined) {
    if (ticker.borrowRate < SIGNAL_BANDS.borrowRatePercent) return undefined
    return `${formatMarketMetric(ticker.borrowRate)}% borrow`
  }
  if (ticker.lendability === undefined || ticker.lendability === 'Easy To Borrow') return undefined
  return ticker.lendability
}

export function instrumentSignals(ticker: Ticker): InstrumentSignal[] {
  const signals: InstrumentSignal[] = []

  if (Math.abs(ticker.changePercent) >= SIGNAL_BANDS.dayMovePercent) {
    signals.push({
      detail: `${ticker.change >= 0 ? '+' : '−'}${formatMarketPrice(Math.abs(ticker.change))} to ${formatMarketPrice(ticker.price)}`,
      key: 'day-move',
      label: `${ticker.changePercent >= 0 ? 'Up' : 'Down'} ${formatMarketMetric(Math.abs(ticker.changePercent))}% today`,
      tone: 'note',
    })
  }

  const ivOverHv = ticker.ivHistoricalVolatility30DayDifference
  if (ivOverHv !== undefined && ticker.ivIndex !== undefined
    && ticker.historicalVolatility30Day !== undefined
    && Math.abs(ivOverHv) >= SIGNAL_BANDS.ivOverHvPoints) {
    signals.push({
      detail: `IV ${formatMarketMetric(ticker.ivIndex)}% · 30-day HV ${formatMarketMetric(ticker.historicalVolatility30Day)}%`,
      key: 'iv-vs-hv',
      label: `IV ${formatSignalPoints(ivOverHv)} ${ivOverHv > 0 ? 'above' : 'below'} realized`,
      tone: ivOverHv > 0 ? 'rich' : 'cheap',
    })
  }

  const ivFiveDay = ticker.ivIndex5DayChange
  if (ivFiveDay !== undefined && ticker.ivIndex !== undefined
    && Math.abs(ivFiveDay) >= SIGNAL_BANDS.ivFiveDayPoints) {
    signals.push({
      detail: `IV now ${formatMarketMetric(ticker.ivIndex)}%`,
      key: 'iv-5-day',
      label: `IV ${ivFiveDay > 0 ? 'up' : 'down'} ${formatSignalPoints(ivFiveDay)} in 5 days`,
      tone: ivFiveDay > 0 ? 'rich' : 'cheap',
    })
  }

  const term = ticker.ivTermStructure
  if (term !== undefined) {
    const spread = termStructureSpread(term)
    if (Math.abs(spread) >= SIGNAL_BANDS.termSpreadPoints) {
      signals.push({
        detail: `${term.frontExpiration} ${formatMarketMetric(term.frontIv)}% · ${term.backExpiration} ${formatMarketMetric(term.backIv)}%`,
        key: 'term-structure',
        label: spread > 0
          ? `Front month priced ${formatSignalPoints(spread)} over back`
          : `Back month priced ${formatSignalPoints(spread)} over front`,
        tone: 'note',
      })
    }
  }

  if (ticker.liquidity !== undefined && ticker.liquidity <= SIGNAL_BANDS.thinLiquidityScore) {
    signals.push({
      detail: `${formatMarketMetric(ticker.liquidity)}/5 tastytrade liquidity`,
      key: 'liquidity',
      label: 'Thin options liquidity',
      tone: 'rich',
    })
  }

  const borrowDetail = borrowFrictionDetail(ticker)
  if (borrowDetail !== undefined) {
    signals.push({
      detail: borrowDetail,
      key: 'borrow',
      label: 'Hard to borrow',
      tone: 'rich',
    })
  }

  const rangePosition = fiftyTwoWeekPosition(ticker)
  if (rangePosition !== undefined && ticker.yearLow !== undefined && ticker.yearHigh !== undefined) {
    const nearLow = rangePosition <= SIGNAL_BANDS.rangeEdgePercent
    const nearHigh = rangePosition >= 100 - SIGNAL_BANDS.rangeEdgePercent
    if (nearLow || nearHigh) {
      signals.push({
        detail: `${Math.round(rangePosition)}% of ${formatMarketPrice(ticker.yearLow)}–${formatMarketPrice(ticker.yearHigh)}`,
        key: 'range-edge',
        label: nearLow ? 'Near 52-week low' : 'Near 52-week high',
        tone: 'note',
      })
    }
  }

  return signals
}
