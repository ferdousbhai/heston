import { z } from 'zod'

import { CatalystSchema } from './catalyst'
import { CandlePointSchema } from './candle'

export const WatchlistKindSchema = z.enum(['private', 'positions', 'public'])

export const WatchlistSchema = z.object({
  id: z.string(),
  kind: WatchlistKindSchema,
  name: z.string(),
  symbols: z.array(z.string()),
})

export const TickerSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  price: z.number(),
  change: z.number(),
  changePercent: z.number(),
  sparkline: z.array(CandlePointSchema).min(1),
  ivRank: z.number().min(0).max(100),
  ivPercentile: z.number().min(0).max(100),
  ivIndex: z.number().min(0),
  liquidity: z.number().min(0).max(5),
  earningsDate: z.string().nullable(),
  position: z.boolean(),
  updatedAt: z.string(),
})

export const ResearchIdeaSchema = z.object({
  symbol: z.string(),
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  setup: z.string(),
  thesis: z.string(),
  risk: z.string(),
  horizon: z.string(),
})

export const ResearchBriefSchema = z.object({
  id: z.string(),
  publishedAt: z.string(),
  title: z.string(),
  summary: z.string(),
  regime: z.string(),
  regimeDetail: z.string(),
  ideas: z.array(ResearchIdeaSchema),
  sources: z.array(z.object({ label: z.string(), url: z.string().url() })),
})

export const MarketSnapshotSchema = z.object({
  source: z.enum(['demo', 'tastytrade']),
  syncedAt: z.string(),
  marketState: z.enum(['open', 'closed', 'pre', 'after', 'unknown']),
  watchlists: z.array(WatchlistSchema),
  tickers: z.array(TickerSchema),
  catalysts: z.array(CatalystSchema),
  research: ResearchBriefSchema,
})

export type Watchlist = z.infer<typeof WatchlistSchema>
export type Ticker = z.infer<typeof TickerSchema>
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>

export type VolatilityVerdict = 'cheap' | 'fair' | 'rich'

const marketMetricFormatter = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 })

export function formatMarketMetric(value: number): string {
  return marketMetricFormatter.format(value)
}

export function volatilityVerdict(ticker: Pick<Ticker, 'ivRank' | 'ivPercentile'>): VolatilityVerdict {
  if (ticker.ivRank <= 30 && ticker.ivPercentile <= 35) return 'cheap'
  if (ticker.ivRank >= 70 || ticker.ivPercentile >= 80) return 'rich'
  return 'fair'
}
