import createYahooFinance from 'yahoo-finance2/createYahooFinance'
import screener from 'yahoo-finance2/modules/screener'
import { z } from 'zod'

import { EquitySymbolSchema } from '../domain/instrument'
import { newYorkClock } from '../domain/market-clock'
import { boundedYahooFetch } from './yahoo-finance-transport'
import { defineSeam, type SeamValue } from './seam'

// Two rows from each Yahoo screen make a balanced six-name discovery packet.
const MAX_MOVERS_PER_CATEGORY = 2
const MIN_DIRECTIONAL_MOVE_PERCENT = 1

const SCREENER_ID = {
  gainer: 'day_gainers',
  loser: 'day_losers',
  'most-active': 'most_actives',
} as const

const MOVER_CATEGORIES = ['gainer', 'loser', 'most-active'] as const
type MoverCategory = typeof MOVER_CATEGORIES[number]

const MoverQuoteSchema = z.object({
  quoteType: z.literal('EQUITY'),
  regularMarketChangePercent: z.number().finite(),
  regularMarketPrice: z.number().finite().positive(),
  regularMarketTime: z.union([z.number().finite().positive(), z.date()]).optional(),
  regularMarketVolume: z.number().finite().nonnegative(),
  symbol: EquitySymbolSchema,
}).passthrough()

const ScreenerResultSchema = z.object({ quotes: z.array(z.unknown()) }).passthrough()

export type YahooMarketMover = {
  category: MoverCategory
  changePercent: number
  observedAt?: string
  price: number
  symbol: string
  volume: number
}

export type YahooMarketMoverContext = {
  fetchedAt: string
  movers: YahooMarketMover[]
  source: 'yahoo'
  status: 'available' | 'unavailable'
  unavailableCategories: MoverCategory[]
}

type YahooScreenerResponse = { quotes: object[] }

export type YahooMarketMoverProvider = {
  screen(category: MoverCategory, count: number): Promise<YahooScreenerResponse>
}

const ResearchYahooFinance = createYahooFinance({ modules: { screener } })

function liveProvider(fetcher: typeof fetch = fetch): YahooMarketMoverProvider {
  // yahoo-finance2 maintains mutable cookie and crumb state, so every collection
  // gets a request-scoped client instead of retaining one in Worker global state.
  const yahoo = new ResearchYahooFinance({
    fetch: boundedYahooFetch(fetcher),
    queue: { concurrency: MOVER_CATEGORIES.length },
    suppressNotices: ['yahooSurvey'],
    validation: { logErrors: false, logOptionsErrors: false },
    versionCheck: false,
  })
  return {
    screen: (category, count) => yahoo.screener({ count, scrIds: SCREENER_ID[category] }),
  }
}

function observedAt(value: number | Date | undefined): Date | undefined {
  if (value === undefined) return undefined
  const date = value instanceof Date ? value : new Date(value > 1e11 ? value : value * 1_000)
  return Number.isNaN(date.getTime()) ? undefined : date
}

function isCurrentMover(
  quote: z.infer<typeof MoverQuoteSchema>,
  category: MoverCategory,
  now: Date,
): boolean {
  const observed = observedAt(quote.regularMarketTime)
  if (observed && newYorkClock(observed).localDate !== newYorkClock(now).localDate) return false
  if (category === 'most-active') return true
  const change = quote.regularMarketChangePercent
  if (Math.abs(change) < MIN_DIRECTIONAL_MOVE_PERCENT) return false
  return category === 'gainer' ? change > 0 : change < 0
}

/** Yahoo is bounded secondary discovery: category failures stay visible but never fail the job. */
export async function collectYahooMarketMovers(
  now = new Date(),
  provider: YahooMarketMoverProvider = liveProvider(),
): Promise<YahooMarketMoverContext> {
  const results = await Promise.allSettled(MOVER_CATEGORIES.map(async (category) => {
    const response = ScreenerResultSchema.parse(await provider.screen(category, MAX_MOVERS_PER_CATEGORY))
    const movers = response.quotes.flatMap((raw) => {
      const quote = MoverQuoteSchema.safeParse(raw).data
      if (!quote || !isCurrentMover(quote, category, now)) return []
      const seen = observedAt(quote.regularMarketTime)
      const mover: YahooMarketMover = {
        category,
        changePercent: quote.regularMarketChangePercent,
        price: quote.regularMarketPrice,
        symbol: quote.symbol,
        volume: quote.regularMarketVolume,
      }
      if (seen) mover.observedAt = seen.toISOString()
      return [mover]
    }).slice(0, MAX_MOVERS_PER_CATEGORY)
    return { category, movers }
  }))
  const unavailableCategories = results.flatMap((result, index) => (
    result.status === 'rejected' ? [MOVER_CATEGORIES[index]!] : []
  ))
  const context: YahooMarketMoverContext = {
    fetchedAt: now.toISOString(),
    movers: results.flatMap((result) => result.status === 'fulfilled' ? result.value.movers : []),
    source: 'yahoo',
    status: unavailableCategories.length === MOVER_CATEGORIES.length ? 'unavailable' : 'available',
    unavailableCategories,
  }
  console.info(JSON.stringify({
    event: 'DailyResearchYahooMoversCompleted',
    movers: context.movers.length,
    status: context.status,
    unavailableCategories,
  }))
  return context
}

const marketMoverResearchSeam = defineSeam(() => ({ collect: collectYahooMarketMovers }))

export type MarketMoverResearch = SeamValue<typeof marketMoverResearchSeam>

export const marketMoverResearch = marketMoverResearchSeam.current
export const setMarketMoverResearch = marketMoverResearchSeam.set
export const resetMarketMoverResearch = marketMoverResearchSeam.reset
