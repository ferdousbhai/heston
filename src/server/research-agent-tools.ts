import { type AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'
import { z } from 'zod'

import { EquitySymbolSchema, EquitySymbolType } from '../domain/instrument'
import { textResult } from './agent-tool-result'
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
  tickers: Type.Array(EquitySymbolType, {
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
    description: 'WallStreetBets hot posts with post text and top comments.',
    execute: async () => textResult(await searchRedditResearch(env, now, options.fetcher)),
    label: 'Searching Reddit',
    name: 'search_reddit',
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
      if (!env.BROWSER) return textResult({ error: 'page reading is unavailable' })
      if (retained && retained.size >= MAX_PAGE_READS) {
        return textResult({ error: 'no page reads left in this run' })
      }
      const response = await env.BROWSER.quickAction('markdown', { url: key })
      const payload = await readBoundedJson(response, MAX_PAGE_RESPONSE_BYTES, 'ResearchReadPage')
      const parsed = z.object({ result: z.string(), success: z.literal(true) })
        .safeParse(payload)
      // A page that would not open is reported to the model so it cites something else,
      // rather than being passed off as an empty read.
      if (!response.ok || !parsed.success) return textResult({ error: 'the page did not open' })
      const markdown = parsed.data.result.slice(0, MAX_PAGE_MARKDOWN_CHARS)
      retained?.set(key, { markdown, readAt: now.toISOString() })
      return textResult({ markdown, url: key })
    },
    label: 'Reading a source page',
    name: 'read_page',
    parameters: ReadPageParameters,
  }
  const coverage: AgentTool<typeof RecentCoverageParameters, RecentTickerCoverage[] | { error: string }> = {
    description: 'Prior Spice ideas for these tickers within daysAgo; today is excluded.',
    execute: async (_toolCallId, params) => {
      // A ticker written the way a post writes it — $NXE — is not a symbol, and today's
      // preview run ended on exactly that: one malformed argument aborted the whole brief.
      // The model can correct a symbol, so it is told rather than stopped.
      const unreadable = params.tickers.find((ticker) => !EquitySymbolSchema.safeParse(ticker).success)
      if (unreadable !== undefined) {
        return textResult({ error: `not a ticker symbol: ${unreadable.slice(0, 12)}` })
      }
      return textResult(await searchRecentTickerCoverage(env, params.tickers, params.daysAgo, now))
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
  ].map(withRunStep)
}
