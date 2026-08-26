import { z } from 'zod'

import { CatalystSchema } from './catalyst'
import { CandlePointSchema } from './candle'
import { type JsonValue } from './json-payload'

const WatchlistKindSchema = z.enum(['private', 'positions', 'public'])

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

const PotentialPlaySchema = z.string().trim().max(40).regex(
  /^[A-Z.]{1,8} \d+(?:\.\d+)?[cp] (?:1[0-2]|[1-9])\/(?:3[01]|[12]\d|[1-9])$/,
  'Use TICKER STRIKE(c/p) M/D',
)

const ResearchIdeaFields = {
  symbol: z.string().regex(/^[A-Z.]{1,8}$/),
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  headline: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(360),
  risk: z.string().trim().min(1).max(240),
}

const ResearchSourceLinkSchema = z.object({
  label: z.string(),
  // Stored briefs predate the current evidence binder. Only web citations may
  // cross that persistence boundary into owner or public anchor elements.
  url: z.string().url().refine((url) => new URL(url).protocol === 'https:', 'Use an HTTPS source URL'),
})

export const ResearchIdeaSchema = z.object({
  ...ResearchIdeaFields,
  play: PotentialPlaySchema,
  sources: z.array(ResearchSourceLinkSchema).max(3),
}).refine((idea) => idea.play.startsWith(`${idea.symbol} `), {
  message: 'Potential play must use the idea symbol',
  path: ['play'],
})

const StoredResearchIdeaSchema = z.object({
  ...ResearchIdeaFields,
  play: PotentialPlaySchema.nullable(),
  sources: z.array(ResearchSourceLinkSchema).max(3),
}).refine((idea) => idea.play === null || idea.play.startsWith(`${idea.symbol} `), {
  message: 'Potential play must use the idea symbol',
  path: ['play'],
})

export const MarketMoverInsightSchema = z.object({
  averageVolume3Month: z.number().nonnegative().optional(),
  category: z.enum(['gainer', 'loser', 'most-active']),
  changePercent: z.number(),
  description: z.string().trim().min(1).max(360),
  headline: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(160),
  price: z.number().positive(),
  sources: z.array(ResearchSourceLinkSchema).min(1).max(3),
  symbol: z.string().regex(/^[A-Z.]{1,8}$/),
  volume: z.number().nonnegative(),
})

export const ResearchBriefSchema = z.object({
  id: z.string(),
  publishedAt: z.string(),
  title: z.string(),
  summary: z.string(),
  regime: z.string(),
  regimeDetail: z.string(),
  ideas: z.array(StoredResearchIdeaSchema).max(5),
  marketMovers: z.array(MarketMoverInsightSchema).max(6),
  sources: z.array(ResearchSourceLinkSchema),
})

const BackwardCompatibleResearchIdeaSchema = z.object({
  ...ResearchIdeaFields,
  play: PotentialPlaySchema.nullable(),
  sources: z.array(ResearchSourceLinkSchema).max(3).default([]),
}).refine((idea) => idea.play === null || idea.play.startsWith(`${idea.symbol} `), {
  message: 'Potential play must use the idea symbol',
  path: ['play'],
})

const CurrentStoredResearchBriefSchema = ResearchBriefSchema.extend({
  ideas: z.array(BackwardCompatibleResearchIdeaSchema).max(5),
  marketMovers: z.array(MarketMoverInsightSchema).max(6).default([]),
})

const PreEvidenceResearchIdeaSchema = z.object({
  symbol: z.string().regex(/^[A-Z.]{1,8}$/),
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  setup: z.string().trim().min(1),
  thesis: z.string().trim().min(1),
  risk: z.string().trim().min(1),
  horizon: z.string().trim().min(1),
}).transform((idea) => ({
  symbol: idea.symbol,
  direction: idea.direction,
  headline: idea.setup.slice(0, 100),
  description: `${idea.thesis} Horizon: ${idea.horizon}.`.slice(0, 360),
  risk: idea.risk.slice(0, 240),
  play: null,
  sources: [],
}))

const PreEvidenceStoredResearchBriefSchema = ResearchBriefSchema
  .omit({ ideas: true, marketMovers: true })
  .extend({ ideas: z.array(PreEvidenceResearchIdeaSchema).max(5) })
  .transform((brief) => ({ ...brief, marketMovers: [] }))

const StoredResearchBriefSchema = z.union([
  CurrentStoredResearchBriefSchema,
  PreEvidenceStoredResearchBriefSchema,
])

/** Normalize every historical D1 payload shape only at the persistence boundary. */
export function parseStoredResearchBrief(value: JsonValue): ResearchBrief {
  return StoredResearchBriefSchema.parse(value)
}

export const MarketSnapshotSchema = z.object({
  source: z.literal('tastytrade'),
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
