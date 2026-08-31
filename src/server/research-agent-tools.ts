import { type AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { z } from 'zod'

import { equitySymbolFromModelText, ModelTextEquitySymbolType } from '../domain/instrument'
import { textResult } from './agent-tool-result'
import { MAX_MARKET_SYMBOLS } from './brokerage-read-contracts'
import { readBoundedJson } from './bounded-response'
import { type JsonValue } from '../domain/json-payload'
import { type AppEnv } from './env'
import {
  MAX_RESEARCH_LOOKBACK_DAYS,
  searchRecentTickerCoverage,
  type RecentTickerCoverage,
} from './research-coverage'
import { collectRedditSources, type RedditDiscussion } from './research-reddit'
import { readStoredSecret } from './secrets'
import {
  createInstrumentQuoteReadTool,
  createMarketMetricsReadTool,
  createOptionContractFindTool,
} from './brokerage-read-tools'

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

const ReadPageParameters = Type.Object({
  url: Type.String({ description: 'HTTPS address of a page to read.' }),
}, { additionalProperties: false })

export type RetainedPage = { markdown: string; readAt: string }

const RetainedPageSchema = z.object({
  markdown: z.string(),
  readAt: z.string(),
  url: z.string(),
})

/*
 * A citation is worth what this Worker can show was read. Native web search happens inside
 * the provider, so a page it opened leaves nothing here to bind a claim to; a page read
 * through this tool leaves its text behind, and the binder afterwards refuses any citation
 * or quote absent from it.
 *
 * A brief cites at most three ideas' sources plus six reading links, so twice that bounds a
 * run while leaving room for pages the model reads and then discards. Markdown is capped far
 * inside the durable workflow step output so a retained page survives replay intact.
 */
const MAX_PAGE_READS = 30
const MAX_PAGE_MARKDOWN_CHARS = 120_000
const MAX_PAGE_RESPONSE_BYTES = 4_000_000

/** A page is retained and cited under one spelling, so both sides agree what "same page" is. */
export function retentionKey(value: string): string | undefined {
  return readablePageUrl(value)?.toString()
}

function readablePageUrl(value: string): URL | undefined {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' || url.username || url.password) return undefined
  if (url.port !== '' && url.port !== '443') return undefined
  // A published source is never a literal address, and that shape is what turns a reading
  // tool into a probe of somewhere it was never meant to reach.
  if (/^\[|^\d{1,3}(\.\d{1,3}){3}$/.test(url.hostname)) return undefined
  return url
}

export interface ResearchAgentToolOptions {
  fetcher?: typeof fetch
  retained?: Map<string, RetainedPage>
  includeReddit?: boolean
  now?: Date
  runStep?: <T>(name: string, task: () => Promise<T>) => Promise<T>
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

export function createResearchAgentTools(
  env: AppEnv,
  options: ResearchAgentToolOptions = {},
): AgentTool[] {
  const now = options.now ?? new Date()
  const runRead = <T>(name: string, task: () => Promise<T>): Promise<T> => (
    options.runStep ? options.runStep(name, task) : task()
  )
  // A page is retained from what the step returned, not from inside it. A workflow replay
  // serves a cached step result without running its closure, so retaining inside would leave
  // the map empty on replay and every citation would fail to bind through no fault of the
  // model. Reading the durable result rebuilds the same map either way.
  const withRetention = (tool: AgentTool): AgentTool => {
    if (tool.name !== 'read_page' || !retained) return tool
    const execute = tool.execute
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const result = await execute(toolCallId, params, signal, onUpdate)
        const page = RetainedPageSchema.safeParse(result.details).data
        if (page) retained.set(page.url, { markdown: page.markdown, readAt: page.readAt })
        return result
      },
    }
  }
  const withRunStep = (tool: AgentTool): AgentTool => {
    const execute = tool.execute
    return {
      ...tool,
      execute: (toolCallId, params, signal, onUpdate) => runRead(
        tool.name,
        () => execute(toolCallId, params, signal, onUpdate),
      ),
    }
  }
  const reddit: AgentTool<typeof RedditSearchParameters, RedditResearchResult> = {
    description: 'Ingest current WallStreetBets hot posts with their text and top comments. Takes no query.',
    execute: async () => textResult(await searchRedditResearch(env, now, options.fetcher)),
    label: 'Ingesting WallStreetBets', 
    name: 'ingest_wsb',
    parameters: RedditSearchParameters,
  }
  const retained = options.retained
  const readPage: AgentTool<typeof ReadPageParameters, JsonValue> = {
    description: 'Read a page as Markdown. Cite only pages read this way.',
    execute: async (_toolCallId, params) => {
      const url = readablePageUrl(params.url)
      if (!url) return textResult({ error: 'not a readable https page address' })
      const key = url.toString()
      const already = retained?.get(key)
      if (already) return textResult({ markdown: already.markdown, url: key })
      if (retained && retained.size >= MAX_PAGE_READS) {
        return textResult({ error: 'no page reads left in this run' })
      }
      // A browser that times out, a session limit, or a body past the cap all mean the same
      // thing to the model — cite something else — so none of them may escape as an error
      // that ends the run.
      const parsed = await (async () => {
        try {
          const response = await env.BROWSER!.quickAction('markdown', { url: key })
          if (!response.ok) return undefined
          const payload = await readBoundedJson(response, MAX_PAGE_RESPONSE_BYTES, 'ResearchReadPage')
          return z.object({ result: z.string(), success: z.literal(true) }).safeParse(payload).data
        } catch {
          return undefined
        }
      })()
      if (!parsed) return textResult({ error: 'the page did not open' })
      const markdown = parsed.result.slice(0, MAX_PAGE_MARKDOWN_CHARS)
      return textResult({ markdown, readAt: now.toISOString(), url: key })
    },
    label: 'Reading a source page',
    name: 'read_page',
    parameters: ReadPageParameters,
  }
  const coverage: AgentTool<typeof RecentCoverageParameters, RecentTickerCoverage[] | { error: string }> = {
    description: 'Prior Spice ideas for these tickers within daysAgo; today is excluded.',
    execute: async (_toolCallId, params) => {
      // X writes tickers as cashtags, and the discovery packet carries them that way, so a
      // leading $ is a convention to read rather than a defect to reject. Today's preview run
      // died on exactly that: $NXE reached this tool, the symbol rule threw, and the whole
      // brief was lost to one argument. Anything still unreadable after that is reported to
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
  return [
    ...(options.includeReddit === false ? [] : [reddit]),
    ...(env.BROWSER ? [readPage] : []),
    coverage,
    createMarketMetricsReadTool(env),
    createOptionContractFindTool(env),
    createInstrumentQuoteReadTool(env),
  ].map(withRunStep).map(withRetention)
}
