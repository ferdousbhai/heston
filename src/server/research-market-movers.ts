import { z } from 'zod'
import createYahooFinance from 'yahoo-finance2/createYahooFinance'
import screener from 'yahoo-finance2/modules/screener'
import search from 'yahoo-finance2/modules/search'

import { EquitySymbolSchema } from '../domain/instrument'
import { newYorkClock } from '../domain/market-clock'
import { type ResearchSourceItem } from './research-contracts'
import { boundedYahooFetch } from './yahoo-finance-transport'
import { defineSeam, type SeamValue } from './seam'

const MAX_PER_CATEGORY = 2
const MAX_NEWS_PER_MOVER = 2
const NEWS_LOOKBACK_MS = 4 * 24 * 60 * 60 * 1_000

/**
 * A directional screen quote must have moved at least this much, in its screen's
 * own direction, to be published as a mover. Yahoo's own `day_gainers` screen
 * filters above +3%, so this only rejects noise that a stale or half-formed
 * quote produces — a "gainer" at -0.42% describes nothing a reader can use.
 */
const MIN_MOVE_PERCENT = 1

const SCREENER_ID = {
  gainer: 'day_gainers',
  loser: 'day_losers',
  'most-active': 'most_actives',
} as const

type MarketMoverCategory = keyof typeof SCREENER_ID

const MoverQuoteSchema = z.object({
  averageDailyVolume3Month: z.number().finite().nonnegative().optional(),
  longName: z.string().trim().min(1).optional(),
  quoteType: z.literal('EQUITY'),
  regularMarketChangePercent: z.number().finite(),
  regularMarketPrice: z.number().finite().positive(),
  // Yahoo reports the screener quote's own observation time as epoch seconds.
  // It is the direct staleness signal; the sign and floor rules below are the
  // fallback for a quote that omits it.
  regularMarketTime: z.union([z.number().finite().positive(), z.date()]).optional(),
  regularMarketVolume: z.number().finite().nonnegative(),
  shortName: z.string().trim().min(1).optional(),
  // Use the source-neutral equity schema here too. A digit-bearing ticker used
  // to pass this fallback boundary and fail later evidence binding.
  symbol: EquitySymbolSchema,
}).passthrough()

const ScreenerResultSchema = z.object({
  quotes: z.array(z.object({
    averageDailyVolume3Month: z.number().optional(),
    longName: z.string().optional(),
    quoteType: z.string(),
    regularMarketChangePercent: z.number(),
    regularMarketPrice: z.number(),
    regularMarketTime: z.union([z.number(), z.date()]).optional(),
    regularMarketVolume: z.number().optional(),
    shortName: z.string().optional(),
    symbol: z.string(),
    tradeable: z.boolean().optional(),
  }).passthrough()),
}).passthrough()

const SearchNewsSchema = z.object({
  link: z.string(),
  providerPublishTime: z.coerce.date(),
  publisher: z.string().trim().min(1),
  relatedTickers: z.array(z.string()).optional(),
  title: z.string().trim().min(1),
}).passthrough()

const SearchResultSchema = z.object({
  news: z.array(SearchNewsSchema),
}).passthrough()

type Mover = z.infer<typeof MoverQuoteSchema> & { category: MarketMoverCategory }
type MarketMoverScreenResult = z.infer<typeof ScreenerResultSchema>
type MarketMoverNewsResult = z.infer<typeof SearchResultSchema>

export type MarketMoverProvider = {
  screen(category: MarketMoverCategory, count: number): Promise<MarketMoverScreenResult>
  searchNews(symbol: string, count: number): Promise<MarketMoverNewsResult>
}

const ResearchYahooFinance = createYahooFinance({ modules: { screener, search } })

function createLiveProvider(fetcher: typeof fetch = fetch): MarketMoverProvider {
  // A client is scoped to one collection. yahoo-finance2 keeps mutable request,
  // cookie, and crumb state that must not cross Worker invocations.
  const yahoo = new ResearchYahooFinance({
    fetch: boundedYahooFetch(fetcher),
    queue: { concurrency: 3 },
    suppressNotices: ['yahooSurvey'],
    validation: { logErrors: false, logOptionsErrors: false },
    versionCheck: false,
  })
  return {
    screen: async (category, count) => ScreenerResultSchema.parse(await yahoo.screener(
      { count, scrIds: SCREENER_ID[category] },
    )),
    searchNews: async (symbol, count) => SearchResultSchema.parse(await yahoo.search(
      symbol,
      { enableCb: false, enableFuzzyQuery: false, enableNavLinks: false, newsCount: count, quotesCount: 0 },
    )),
  }
}

function httpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function quoteObservedAt(quote: z.infer<typeof MoverQuoteSchema>): Date | undefined {
  const value = quote.regularMarketTime
  if (value === undefined) return undefined
  // Yahoo sends epoch seconds here; tolerate milliseconds so a provider change
  // degrades to "unknown observation time" rather than "observed in 1970".
  const at = value instanceof Date ? value : new Date(value > 1e11 ? value : value * 1_000)
  return Number.isNaN(at.getTime()) ? undefined : at
}

/**
 * A published mover must agree with itself. The weekday research job fires one
 * second after the 09:30 New York open, when Yahoo's screens still serve the
 * prior session's `regularMarket*` fields: that is how a `day_gainers` quote
 * ships at -3.26% and how a "most active" name shows 15x its average volume
 * before a single share has traded.
 *
 * Every failure drops the quote. Relabelling by sign would keep publishing
 * yesterday's price, volume, and headline window under today's date, which is a
 * worse lie than a short movers list; movers are best-effort secondary context,
 * so an empty screen is an acceptable outcome and a stale one is not.
 */
function isPublishableMover(
  quote: z.infer<typeof MoverQuoteSchema>,
  category: MarketMoverCategory,
  now: Date,
): boolean {
  const observedAt = quoteObservedAt(quote)
  if (observedAt && newYorkClock(observedAt).localDate !== newYorkClock(now).localDate) return false
  // `most-active` claims volume, not direction, so no sign follows from it.
  if (category === 'most-active') return true
  const changePercent = quote.regularMarketChangePercent
  if (Math.abs(changePercent) < MIN_MOVE_PERCENT) return false
  return category === 'gainer' ? changePercent > 0 : changePercent < 0
}

function signedPercent(value: number): string {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function marketMoverMetadata(mover: Mover): NonNullable<ResearchSourceItem['marketMover']> {
  const metadata: NonNullable<ResearchSourceItem['marketMover']> = {
    category: mover.category,
    changePercent: mover.regularMarketChangePercent,
    name: mover.shortName ?? mover.longName ?? mover.symbol,
    price: mover.regularMarketPrice,
    symbol: mover.symbol,
    volume: mover.regularMarketVolume,
  }
  if (mover.averageDailyVolume3Month !== undefined) {
    metadata.averageVolume3Month = mover.averageDailyVolume3Month
  }
  return metadata
}

function moveContext(mover: Mover): string {
  const averageVolume = mover.averageDailyVolume3Month
  const relativeVolume = averageVolume && averageVolume > 0
    ? `, ${(mover.regularMarketVolume / averageVolume).toFixed(1)}x its three-month average volume`
    : ''
  return `${mover.symbol} is a ${mover.category} at $${mover.regularMarketPrice.toFixed(2)}, ${signedPercent(mover.regularMarketChangePercent)} on ${Math.round(mover.regularMarketVolume).toLocaleString('en-US')} shares${relativeVolume}.`
}

function quoteUrl(symbol: string): string {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`
}

async function evidenceForMover(
  provider: MarketMoverProvider,
  mover: Mover,
  now: Date,
): Promise<ResearchSourceItem[]> {
  const result = await provider.searchNews(mover.symbol, MAX_NEWS_PER_MOVER + 2)
    .catch((): MarketMoverNewsResult => ({ news: [] }))
  const earliest = now.getTime() - NEWS_LOOKBACK_MS
  const latest = now.getTime() + 5 * 60 * 1_000
  const news = result.news.flatMap((article) => {
    const publishedAt = article.providerPublishTime.getTime()
    const link = httpsUrl(article.link)
    if (!link || publishedAt < earliest || publishedAt > latest
      || !article.relatedTickers?.some((ticker) => ticker.toUpperCase() === mover.symbol)) return []
    return [{ ...article, link }]
  }).slice(0, MAX_NEWS_PER_MOVER)
  const metadata = marketMoverMetadata(mover)
  const baseContext = moveContext(mover)

  if (!news.length) {
    return [{
      context: `${baseContext} Yahoo returned no recent symbol-linked headline, so the cause is unconfirmed and must not be invented.`,
      marketMover: metadata,
      source: 'Yahoo Finance market movers',
      symbols: [mover.symbol],
      title: `${mover.symbol} ${signedPercent(mover.regularMarketChangePercent)} · driver unconfirmed`,
      url: quoteUrl(mover.symbol),
    }]
  }

  return news.map((article) => ({
    context: `${baseContext} Yahoo associates this recent headline with ${mover.symbol}: ${article.title.slice(0, 240)}. Association is not proof of causation; describe it as a possible driver unless the headline itself is explicit.`,
    marketMover: metadata,
    outbound: {
      label: `${article.publisher.slice(0, 80)} · ${article.title.slice(0, 160)}`,
      url: article.link,
    },
    publishedAt: article.providerPublishTime.toISOString(),
    source: 'Yahoo Finance market movers',
    symbols: [mover.symbol],
    title: `${mover.symbol} ${signedPercent(mover.regularMarketChangePercent)} · ${article.title.slice(0, 160)}`,
    url: quoteUrl(mover.symbol),
  }))
}

/**
 * Gather a balanced, bounded view of broad US equity movement, then attach only
 * recent Yahoo news explicitly related to each symbol. Search failures become an
 * honest "driver unconfirmed" item; they never turn model inference into fact.
 */
export async function collectMarketMoverEvidence(
  provider: MarketMoverProvider = createLiveProvider(),
  now = new Date(),
): Promise<ResearchSourceItem[]> {
  const categories: readonly MarketMoverCategory[] = ['gainer', 'loser', 'most-active']
  const results = await Promise.allSettled(categories.map(async (category) => {
    const result = await provider.screen(category, MAX_PER_CATEGORY)
    return result.quotes.flatMap((quote) => {
      // Yahoo's `tradeable` means tradeable through Yahoo, not exchange-listed.
      // It is currently false for ordinary US equities, so quoteType is the
      // authoritative asset-class filter here.
      const parsed = MoverQuoteSchema.safeParse(quote).data
      if (!parsed || !isPublishableMover(parsed, category, now)) return []
      return [{ ...parsed, category }]
    }).slice(0, MAX_PER_CATEGORY)
  }))
  const movers = new Map<string, Mover>()
  for (const result of results) {
    if (result.status !== 'fulfilled') continue
    for (const mover of result.value) {
      if (!movers.has(mover.symbol)) movers.set(mover.symbol, mover)
    }
  }
  const evidence = await Promise.allSettled(
    [...movers.values()].map((mover) => evidenceForMover(provider, mover, now)),
  )
  return evidence.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
}

const marketMoverResearchSeam = defineSeam(() => ({
  collect: (now?: Date) => collectMarketMoverEvidence(undefined, now),
}))

export type MarketMoverResearch = SeamValue<typeof marketMoverResearchSeam>

export const marketMoverResearch = marketMoverResearchSeam.current

export const setMarketMoverResearch = marketMoverResearchSeam.set

export const resetMarketMoverResearch = marketMoverResearchSeam.reset
