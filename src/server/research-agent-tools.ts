import { type AgentTool } from '../domain/agent-tool'
import { Type } from 'typebox'
import { z } from 'zod'

import { equitySymbolsFromModelText, ModelTextEquitySymbolType } from '../domain/instrument'
import { textResult } from './agent-tool-result'
import { MAX_MARKET_SYMBOLS } from './brokerage-read-contracts'
import { readBoundedJson } from './bounded-response'
import { type AppEnv } from './env'
import { MAX_RESEARCH_PAGE_READS } from './research-contracts'
import {
  MAX_RECENT_COVERAGE_ROWS,
  MAX_RESEARCH_LOOKBACK_DAYS,
  searchRecentTickerCoverage,
  type RecentCoverageResult,
} from './research-coverage'
import { collectRedditSources, type RedditDiscussion } from './research-reddit'
import { recommendationLinkKey } from './research-url'
import { readStoredSecret } from './secrets'

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

export interface RetainedCitedPages {
  rejected: string[]
  /** Empty whenever anything was rejected: no binder may run on a partial set of reads. */
  retained: Map<string, RetainedPage>
}

/**
 * Read every page a set of citations points at, once each, and retain its text for the binders.
 *
 * Both surfaces that admit model-authored citations -- the publish boundary and a member's
 * catalyst recording -- face the same sequence in the same order: canonicalize the cited
 * addresses, refuse before spending a browser budget the citations would overrun, then read each
 * distinct page and refuse if one did not open. One definition, so neither surface can quietly
 * hold a citation to a weaker rule than the other.
 *
 * Indices are not deduplicated: a bad address cited twice is named once per citation, which is
 * what an agent fixes. Distinct pages are, because a page that will not open is one fact about
 * that page however many citations lean on it.
 *
 * `readBudgetUnit` is the only thing the two differ by: the same ceiling is a run's when a brief
 * publishes, and a call's when an agent records what it researched.
 */
export async function retainCitedPages(
  browser: NonNullable<AppEnv['BROWSER']>,
  sources: readonly { sourceUrl: string }[],
  citedIndices: Iterable<number>,
  readAt: string,
  readBudgetUnit: 'call' | 'run',
): Promise<RetainedCitedPages> {
  const rejected: string[] = []
  const pageKeys = new Set<string>()
  for (const index of citedIndices) {
    const sourceUrl = sources[index]?.sourceUrl
    // An index past the end of sources has no page to read; the binders reject the citation.
    if (sourceUrl === undefined) continue
    const key = recommendationLinkKey(sourceUrl)
    if (key === undefined) rejected.push(`source ${index}: not a readable https page address`)
    else pageKeys.add(key)
  }
  if (pageKeys.size > MAX_RESEARCH_PAGE_READS) {
    return {
      rejected: [`cites ${pageKeys.size} pages; at most ${MAX_RESEARCH_PAGE_READS} are read in one ${readBudgetUnit}`],
      retained: new Map(),
    }
  }
  if (rejected.length) return { rejected, retained: new Map() }

  const retained = new Map<string, RetainedPage>()
  for (const key of pageKeys) {
    const markdown = await readResearchPageMarkdown(browser, key)
    if (markdown === undefined) rejected.push(`page did not open: ${key}`)
    else retained.set(key, { markdown, readAt })
  }
  if (rejected.length) return { rejected, retained: new Map() }
  return { rejected, retained }
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
): AgentTool<typeof RecentCoverageParameters, RecentCoverageResult | { error: string }> {
  return {
    description: `Prior Heston recommendations for these tickers within daysAgo, newest first;
      today is excluded. At most ${MAX_RECENT_COVERAGE_ROWS} rows, and \`truncated\` says when 
      there were more -- narrow the tickers or the window rather than reading past it.`
      .replace(/\s+/g, ' '),
    execute: async (_toolCallId, params) => {
      // X writes tickers as cashtags, and the discovery packet carries them that way, so a
      // leading $ is a convention to read rather than a defect to reject. Today's preview run
      // died on exactly that: $NXE reached this tool, the symbol rule threw, and the whole
      // daily output was lost to one argument. Anything still unreadable after that is reported to
      // the model, which can correct a symbol, instead of ending the run.
      const parsed = equitySymbolsFromModelText(params.tickers)
      if ('unreadable' in parsed) {
        return textResult({ error: `not a ticker symbol: ${parsed.unreadable.slice(0, 12)}` })
      }
      return textResult(await searchRecentTickerCoverage(env, parsed.symbols, params.daysAgo, now))
    },
    label: 'Reading recent coverage',
    name: 'get_recent_coverage',
    parameters: RecentCoverageParameters,
  }
}
