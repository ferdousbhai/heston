import { type AgentTool } from '../domain/agent-tool'
import { Type } from 'typebox'
import { z } from 'zod'

import { equitySymbolFromModelText, ModelTextEquitySymbolType } from '../domain/instrument'
import { textResult } from './agent-tool-result'
import { MAX_MARKET_SYMBOLS } from './brokerage-read-contracts'
import { readBoundedJson } from './bounded-response'
import { type AppEnv } from './env'
import {
  MAX_RESEARCH_LOOKBACK_DAYS,
  searchRecentTickerCoverage,
  type RecentTickerCoverage,
} from './research-coverage'
import { collectRedditSources, type RedditDiscussion } from './research-reddit'
import { readStoredSecret } from './secrets'
import { recommendationLinkKey } from './research-url'

const RedditSearchParameters = Type.Object({}, { additionalProperties: false })
const RecentCoverageParameters = Type.Object({
  daysAgo: Type.Integer({
    description: 'Calendar days before this run.',
    maximum: MAX_RESEARCH_LOOKBACK_DAYS,
    minimum: 1,
  }),
  tickers: Type.Array(ModelTextEquitySymbolType, {
    description: 'Ticker symbols; a leading $ cashtag is read as the bare symbol.',
    // The lookback fans into one D1 query, so it takes the same batch budget every other
    // symbol read here does rather than being the one unbounded set.
    maxItems: MAX_MARKET_SYMBOLS,
    minItems: 1,
  }),
}, { additionalProperties: false })

export interface RedditResearchResult {
  discussions: RedditDiscussion[]
  fetchedAt: string
  source: 'reddit'
}

export type RetainedPage = { markdown: string; readAt: string }

/*
 * A citation is worth what this Worker can show was read. Native web search happens inside
 * the provider, so a page it opened leaves nothing here to bind a claim to; a page read
 * through this function leaves its text behind, and the binder afterwards refuses any citation
 * or quote absent from it.
 *
 * Markdown is capped far inside the durable workflow step output so a retained page survives replay intact.
 */
const MAX_PAGE_MARKDOWN_CHARS = 120_000
const MAX_PAGE_RESPONSE_BYTES = 4_000_000

/** A page is retained and cited under one spelling, so both sides agree what "same page" is. */
export function retentionKey(value: string): string | undefined {
  return recommendationLinkKey(value)
}

/**
 * One page read through the Worker's browser, used at the publish boundary so a citation is
 * always checked against text this Worker fetched itself.
 * A browser timeout, session limit, or oversized body all return undefined: the caller's
 * contract is "cite something else", never a run-ending error.
 */
export async function readResearchPageMarkdown(
  browser: NonNullable<AppEnv['BROWSER']>,
  key: string,
): Promise<string | undefined> {
  try {
    const response = await browser.quickAction('markdown', { url: key })
    if (!response.ok) return undefined
    const payload = await readBoundedJson(response, MAX_PAGE_RESPONSE_BYTES, 'ResearchReadPage')
    const parsed = z.object({ result: z.string(), success: z.literal(true) }).safeParse(payload).data
    return parsed?.result.slice(0, MAX_PAGE_MARKDOWN_CHARS)
  } catch {
    return undefined
  }
}

export async function searchRedditResearch(
  env: AppEnv,
  now = new Date(),
  fetcher: typeof fetch = fetch,
): Promise<RedditResearchResult> {
  if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) throw new Error('RedditResearchUnavailable')
  const [clientId, clientSecret] = await Promise.all([
    readStoredSecret(env.REDDIT_CLIENT_ID, 'REDDIT_CLIENT_ID'),
    readStoredSecret(env.REDDIT_CLIENT_SECRET, 'REDDIT_CLIENT_SECRET'),
  ])
  const discussions = await collectRedditSources({ clientId, clientSecret }, fetcher)
  return {
    discussions,
    fetchedAt: now.toISOString(),
    source: 'reddit',
  }
}

export function createRedditIngestTool(
  env: AppEnv,
  now = new Date(),
  fetcher?: typeof fetch,
): AgentTool<typeof RedditSearchParameters, RedditResearchResult> {
  return {
    description: 'Ingest current WallStreetBets hot posts with their text and top comments. Takes no query.',
    execute: async () => textResult(await searchRedditResearch(env, now, fetcher)),
    label: 'Ingesting WallStreetBets',
    name: 'ingest_wsb',
    parameters: RedditSearchParameters,
  }
}

export function createRecentCoverageTool(
  env: AppEnv,
  now = new Date(),
): AgentTool<typeof RecentCoverageParameters, RecentTickerCoverage[] | { error: string }> {
  return {
    description: 'Prior Spice recommendations for these tickers within daysAgo; today is excluded.',
    execute: async (_toolCallId, params) => {
      // X writes tickers as cashtags, and the discovery packet carries them that way, so a
      // leading $ is a convention to read rather than a defect to reject. Today's preview run
      // died on exactly that: $NXE reached this tool, the symbol rule threw, and the whole
      // daily output was lost to one argument. Anything still unreadable after that is reported to
      // the model, which can correct a symbol, instead of ending the run.
      const tickers = params.tickers.map((ticker) => equitySymbolFromModelText(ticker))
      const unreadable = params.tickers.find((_ticker, index) => tickers[index] === undefined)
      if (unreadable !== undefined) {
        return textResult({ error: `not a ticker symbol: ${unreadable.slice(0, 12)}` })
      }
      return textResult(await searchRecentTickerCoverage(env, tickers.filter((t) => t !== undefined), params.daysAgo, now))
    },
    label: 'Reading recent coverage',
    name: 'get_recent_coverage',
    parameters: RecentCoverageParameters,
  }
}
