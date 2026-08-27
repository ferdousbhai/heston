import { z } from 'zod'
import createYahooFinance from 'yahoo-finance2/createYahooFinance'
import search from 'yahoo-finance2/modules/search'

import { EquitySymbolSchema } from '../domain/instrument'
import { MAX_DAILY_RESEARCH_LEADS, type ResearchSourceItem } from './research-contracts'
import { boundedYahooFetch } from './yahoo-finance-transport'

const MAX_NEWS_PER_SYMBOL = 3
const NEWS_LOOKBACK_MS = 4 * 24 * 60 * 60_000

const SearchNewsSchema = z.object({
  link: z.string(),
  providerPublishTime: z.coerce.date(),
  publisher: z.string().trim().min(1),
  relatedTickers: z.array(z.string()).optional(),
  title: z.string().trim().min(1),
}).passthrough()

const SearchResultSchema = z.object({ news: z.array(SearchNewsSchema) }).passthrough()

type TickerNewsResult = z.infer<typeof SearchResultSchema>

export type TickerResearchProvider = {
  searchNews(symbol: string, count: number): Promise<TickerNewsResult>
}

const ResearchYahooFinance = createYahooFinance({ modules: { search } })

function createLiveProvider(fetcher: typeof fetch = fetch): TickerResearchProvider {
  // Keep mutable Yahoo cookie, crumb, and queue state inside one collection.
  const yahoo = new ResearchYahooFinance({
    fetch: boundedYahooFetch(fetcher),
    queue: { concurrency: 3 },
    suppressNotices: ['yahooSurvey'],
    validation: { logErrors: false, logOptionsErrors: false },
    versionCheck: false,
  })
  return {
    searchNews: async (symbol, count) => SearchResultSchema.parse(await yahoo.search(
      symbol,
      { enableCb: false, enableFuzzyQuery: false, enableNavLinks: false, newsCount: count, quotesCount: 0 },
    )),
  }
}

function httpsUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    const isDiscoveryProvider = host === 'reddit.com' || host.endsWith('.reddit.com')
      || host === 'redd.it' || host.endsWith('.redd.it')
    return url.protocol === 'https:' && !isDiscoveryProvider ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function quoteUrl(symbol: string): string {
  return `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`
}

async function tickerEvidence(
  provider: TickerResearchProvider,
  symbol: string,
  now: Date,
): Promise<ResearchSourceItem[]> {
  const result = await provider.searchNews(symbol, MAX_NEWS_PER_SYMBOL + 2)
  const earliest = now.getTime() - NEWS_LOOKBACK_MS
  const latest = now.getTime() + 5 * 60_000
  return result.news.flatMap((article) => {
    const publishedAt = article.providerPublishTime.getTime()
    const link = httpsUrl(article.link)
    if (!link || publishedAt < earliest || publishedAt > latest
      || /\breddit\b/i.test(article.publisher)
      || !article.relatedTickers?.some((ticker) => ticker.toUpperCase() === symbol)) return []
    const title = article.title.slice(0, 240)
    return [{
      context: `${article.publisher.slice(0, 80)} published a recent headline explicitly associated with ${symbol}: ${title}. Analyze the claim against the supplied market metrics; the headline is evidence, not a ready-made thesis.`,
      outbound: { label: `${article.publisher.slice(0, 80)} · ${title.slice(0, 160)}`, url: link },
      publishedAt: article.providerPublishTime.toISOString(),
      source: 'Yahoo Finance ticker research',
      symbols: [symbol],
      title: `${symbol} · ${title.slice(0, 180)}`,
      url: quoteUrl(symbol),
    }]
  }).slice(0, MAX_NEWS_PER_SYMBOL)
}

/** Search each discussion-derived ticker independently; the discussion itself is never evidence. */
export async function collectTickerResearchSources(
  symbols: readonly string[],
  provider: TickerResearchProvider = createLiveProvider(),
  now = new Date(),
): Promise<ResearchSourceItem[]> {
  const requested = z.array(EquitySymbolSchema).max(MAX_DAILY_RESEARCH_LEADS)
    .parse([...new Set(symbols)])
  const results = await Promise.allSettled(requested.map((symbol) => tickerEvidence(provider, symbol, now)))
  return results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
}
