import { z } from 'zod'

import { CatalystSchema, snapshotCatalyst } from './catalyst'
import { CandlePointSchema, MAX_YEAR_CANDLES } from './candle'
import { EquitySymbolSchema } from './instrument'
import { IsoDateSchema } from './iso-date'
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

const IvTermStructureSchema = z.object({
  backExpiration: IsoDateSchema,
  backIv: z.number().min(0),
  frontExpiration: IsoDateSchema,
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
  // Where this symbol's year began. Enough to sort by return and print the move; the closes
  // themselves are large enough that carrying them here cost every reader a year of history
  // per tab focus, including the ones whose screens never draw the chart.
  yearAgoClose: z.number().positive().optional(),
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
  /** The provider's instant for the quote. */
  updatedAt: z.string(),
  /**
   * The provider's instant for the volatility and liquidity readings, which it computes on its
   * own schedule and can leave hours behind the quote. Absent for a row stored before the
   * instant was kept; the screen says so rather than borrowing the quote's.
   */
  metricsUpdatedAt: z.string().optional(),
})

/**
 * Both audiences now carry identical ticker fields: the held-position flag is gone, because
 * reading positions needs the member's own broker credential, which this Worker does not hold.
 * Held context reaches a reader through their own agent instead. The audiences still differ on
 * the watchlist, whose `kind` reveals provenance, so the two snapshot contracts stay distinct.
 */
export const PublicTickerSchema = TickerSchema.omit({ earningsDate: true, sparkline: true }).extend({
  earningsDate: z.string().nullable().optional(),
  sparkline: z.array(CandlePointSchema).optional(),
}).strict()

const RecommendationFields = {
  symbol: EquitySymbolSchema,
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  headline: z.string().min(1).max(100),
  description: z.string().min(1).max(360),
  risk: z.string().min(1).max(240),
}

/** One rule for every page address a brief publishes, stated once. */
export const HttpsSourceUrlSchema = z.string().url()
  .refine((url) => new URL(url).protocol === 'https:', 'Use an HTTPS source URL')

const ResearchSourceLinkSchema = z.object({
  label: z.string(),
  // Stored recommendations predate the current evidence binder. Only web citations may
  // cross that persistence boundary into owner or public anchor elements.
  url: HttpsSourceUrlSchema,
})

/**
 * A quote is one sentence of a page, not a page. The publish boundary holds a submission to
 * this same bound, so the quote a brief stores is the quote the binder matched.
 */
export const MAX_RESEARCH_EVIDENCE_QUOTE_LENGTH = 300

/**
 * The verbatim quote a recommendation leans on and the page it was read from. Both were
 * already public — the quote comes from a page the brief cites by URL — and keeping them with
 * the recommendation is what lets the claim be put back against its source afterwards, by a
 * reader or by `challenge_recommendation`. A brief published before this was retained has none.
 */
const RecommendationEvidenceSchema = z.object({
  quote: z.string().min(1).max(MAX_RESEARCH_EVIDENCE_QUOTE_LENGTH),
  url: HttpsSourceUrlSchema,
})

/**
 * What a later re-read of a recommendation's own sources found. `holds` means every quote was
 * still in the page the Worker fetched again; `stale` names in `reasons` what was not — a page
 * that no longer opens, or a quote no longer in it. Absent until someone challenges it:
 * unchecked is not the same claim as checked and holding.
 */
export const RecommendationVerificationSchema = z.object({
  checkedAt: z.string(),
  reasons: z.array(z.string()),
  status: z.enum(['holds', 'stale']),
})

export const RecommendationSchema = z.object({
  ...RecommendationFields,
  evidence: z.array(RecommendationEvidenceSchema).optional(),
  recommendedOrder: RecommendedOrderSchema,
  sources: z.array(ResearchSourceLinkSchema),
  verification: RecommendationVerificationSchema.optional(),
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
  url: HttpsSourceUrlSchema,
})

/**
 * A model identifier as the agent's own runtime names it, one line of it. A rendering envelope
 * for a self-reported value: the brief says which model produced it because a reader deciding
 * how much to trust a brief deserves to know, and the submitting agent is the only party that
 * can say. The submission requires it; a brief published before it was recorded carries none.
 */
export const MAX_RESEARCH_MODEL_NAME_LENGTH = 80

/** Agents often report a marketing line. The cover names the product that produced the brief. */
export function researchGeneratorLabel(model: string): string {
  const cut = model.search(/\s+(?:powered by|running on)\s+/i)
  return (cut > 0 ? model.slice(0, cut) : model).trim()
}

/**
 * The envelope a cited source arrives in, wherever it is cited: a page address and the page's
 * own title. Every surface that admits a citation -- the brief, a recorded catalyst, an
 * evidence card -- holds it to these, so a page a brief may cite is a page a card may cite.
 * The address bound is a rendering and storage envelope, not a URL-spec limit; the title is
 * held to one line at the card's measure.
 */
export const MAX_CITED_SOURCE_URL_LENGTH = 2_000
export const MAX_CITED_SOURCE_TITLE_LENGTH = 180

/**
 * How the publishing member wants to be credited, in their own words: a handle, not a name we
 * hold. It shares one line on the brief cover with the model that produced the brief, which is
 * what the bound is for — a handle that does not fit beside the model name on a phone is a
 * sentence, and the cover is not where a sentence goes. Nothing account-derived ever fills it:
 * the member types it into the submission or leaves it out, and a brief without one shows none.
 */
export const MAX_RESEARCH_BYLINE_LENGTH = 40

export const DailyRecommendationsSchema = z.object({
  id: z.string(),
  publishedAt: z.string(),
  /** Chosen by the publishing member for this brief. Never a Google name or a user id. */
  byline: z.string().min(1).max(MAX_RESEARCH_BYLINE_LENGTH).optional(),
  /** Reported by the agent that submitted the brief, and shown as reported. */
  model: z.string().min(1).max(MAX_RESEARCH_MODEL_NAME_LENGTH).optional(),
  title: z.string(),
  summary: z.string(),
  regime: z.string(),
  regimeDetail: z.string(),
  recommendations: z.array(RecommendationSchema),
  links: z.array(RecommendationLinkSchema),
  // No brief-level source list: it was every recommendation's sources and every link's title
  // concatenated, so a fifth of the brief restated addresses that sit on the thing they belong
  // to. Nothing read it. A stored brief that still carries one parses and drops it here.
})

/** D1 stores the current public recommendation contract; incompatible rows fail visibly. */
export function parseStoredDailyRecommendations(value: JsonValue): DailyRecommendations {
  const parsed = DailyRecommendationsSchema.parse(value)
  if (parsed.model === undefined) return parsed
  const model = researchGeneratorLabel(parsed.model)
  return model === parsed.model ? parsed : { ...parsed, model }
}

/**
 * A year of daily closes, oldest first. Only the closes travel: the year chart spaces points
 * by index because a daily grid is near-uniform, so the instants would be sent and never read.
 */
export const YearCandlesSchema = z.object({
  /** The oldest stored refresh among the series carried; absent when nothing is stored. */
  asOf: z.string().optional(),
  series: z.array(z.object({
    closes: z.array(z.number().finite().positive()).max(MAX_YEAR_CANDLES),
    symbol: EquitySymbolSchema,
  })),
})

export const MarketStateSchema = z.enum(['open', 'closed', 'pre', 'after', 'unknown'])

export type MarketState = z.infer<typeof MarketStateSchema>

const REGULAR_SESSION_OPEN_FORMATTER = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  timeZone: 'America/New_York',
  weekday: 'short',
})

/**
 * Cloudflare cron is UTC and cannot name "09:30 America/New_York", so the Worker fires both
 * DST offsets and this keeps the year-candle read on the fire that is actually the cash open.
 */
export function isRegularSessionOpen(at: Date): boolean {
  const parts = Object.fromEntries(
    REGULAR_SESSION_OPEN_FORMATTER.formatToParts(at).map((part) => [part.type, part.value]),
  )
  if (parts.weekday === 'Sat' || parts.weekday === 'Sun') return false
  return parts.hour === '09' && parts.minute === '30'
}

export const MarketSnapshotSchema = z.object({
  source: z.literal('tastytrade'),
  syncedAt: z.string(),
  marketState: MarketStateSchema,
  // Present when the provider named an opening bell for the current session; a reader waiting
  // through pre-market is counting down to this.
  marketOpensAt: z.string().optional(),
  // Present when the provider named a close that is still ahead, so an open session can count
  // down to the bell rather than inventing 16:00 ET.
  marketClosesAt: z.string().optional(),
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
  marketClosesAt: z.string().optional(),
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
/** A cited page as a brief publishes it: the label a reader sees and the address it opens. */
export type ResearchSourceLink = z.infer<typeof ResearchSourceLinkSchema>
export type RecommendationVerification = z.infer<typeof RecommendationVerificationSchema>
export type MarketSnapshot = z.infer<typeof MarketSnapshotSchema>
export type PublicMarketSnapshot = z.infer<typeof PublicMarketSnapshotSchema>
export type PublicTicker = z.infer<typeof PublicTickerSchema>

export function publicTickerFromTicker(ticker: Ticker): PublicTicker {
  return PublicTickerSchema.parse(ticker)
}

/** REST never fills sparklines (those arrive on the live feed) and most names have no
 *  earnings date. Omitting the empty fields is what a visitor actually downloads. */
export type SlimPublicTicker = Omit<PublicTicker, 'earningsDate' | 'sparkline'> & {
  earningsDate?: string
  sparkline?: PublicTicker['sparkline']
}

export function slimPublicTicker(ticker: PublicTicker): SlimPublicTicker {
  const { earningsDate, sparkline = [], ...rest } = ticker
  if (sparkline.length && earningsDate) return { ...rest, earningsDate, sparkline }
  if (sparkline.length) return { ...rest, sparkline }
  if (earningsDate) return { ...rest, earningsDate }
  return rest
}

export function slimPublicSnapshot(snapshot: PublicMarketSnapshot): JsonValue {
  return {
    ...snapshot,
    catalysts: snapshot.catalysts.map(snapshotCatalyst),
    tickers: snapshot.tickers.map(slimPublicTicker),
  }
}

/** Convert a validated account-free response into the browser's internal model. */
export function tickerFromPublic(ticker: PublicTicker): Ticker {
  return {
    ...ticker,
    earningsDate: ticker.earningsDate ?? null,
    sparkline: ticker.sparkline ?? [],
  }
}

export function marketSnapshotFromPublic(snapshot: PublicMarketSnapshot): MarketSnapshot {
  return MarketSnapshotSchema.parse({
    ...snapshot,
    tickers: snapshot.tickers.map(tickerFromPublic),
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
