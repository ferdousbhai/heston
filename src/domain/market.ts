import { z } from 'zod'

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
  sparkline: z.array(z.number()).min(2),
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
  pulse: z.array(z.object({ label: z.string(), value: z.string(), tone: z.enum(['up', 'down', 'neutral']) })),
  ideas: z.array(ResearchIdeaSchema),
  sources: z.array(z.object({ label: z.string(), url: z.string().url() })),
})

export const MarketSnapshotSchema = z.object({
  source: z.enum(['demo', 'tastytrade']),
  syncedAt: z.string(),
  marketState: z.enum(['open', 'closed', 'pre', 'after', 'unknown']),
  watchlists: z.array(WatchlistSchema),
  tickers: z.array(TickerSchema),
  research: ResearchBriefSchema,
})

export type Watchlist = z.infer<typeof WatchlistSchema>
export type Ticker = z.infer<typeof TickerSchema>
export type ResearchBrief = z.infer<typeof ResearchBriefSchema>
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>

export type VolatilityVerdict = 'cheap' | 'fair' | 'rich'

export function volatilityVerdict(ticker: Pick<Ticker, 'ivRank' | 'ivPercentile'>): VolatilityVerdict {
  if (ticker.ivRank <= 30 && ticker.ivPercentile <= 35) return 'cheap'
  if (ticker.ivRank >= 70 || ticker.ivPercentile >= 80) return 'rich'
  return 'fair'
}

export function optionsTemperatureCopy(ticker: Ticker): { title: string; detail: string } {
  const verdict = volatilityVerdict(ticker)
  if (verdict === 'cheap') {
    return {
      title: 'Premium is relatively cool',
      detail: `IV rank is ${ticker.ivRank} and IV percentile is ${ticker.ivPercentile}. Premium has spent most of the past year above today’s relative level.`,
    }
  }
  if (verdict === 'rich') {
    return {
      title: 'Premium is running hot',
      detail: `IV rank is ${ticker.ivRank} and IV percentile is ${ticker.ivPercentile}. Demand a clear catalyst or favor defined-risk premium structures.`,
    }
  }
  return {
    title: 'Premium is near its middle range',
    detail: `IV rank is ${ticker.ivRank} and IV percentile is ${ticker.ivPercentile}. Structure and catalyst timing matter more than outright volatility.`,
  }
}
