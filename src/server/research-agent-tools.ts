import { Type } from '@earendil-works/pi-ai'
import { type AgentTool } from '@earendil-works/pi-agent-core'

import { EQUITY_SYMBOL_PATTERN } from '../domain/instrument'
import { textResult } from './agent-tool-result'
import { type AppEnv } from './env'
import { searchRecentTickerCoverage, type RecentTickerCoverage } from './research-coverage'
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
    description: 'Calendar-day lookback for prior Spice recommendations.',
    maximum: 365,
    minimum: 1,
  }),
  tickers: Type.Array(Type.String({ pattern: EQUITY_SYMBOL_PATTERN }), {
    description: 'Exact equity tickers to check for prior coverage.',
    maxItems: 20,
    minItems: 1,
  }),
}, { additionalProperties: false })

export interface RedditResearchResult {
  discussions: RedditDiscussion[]
  fetchedAt: string
  source: 'reddit'
}

export interface ResearchAgentToolOptions {
  fetcher?: typeof fetch
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
  const reddit: AgentTool<typeof RedditSearchParameters, RedditResearchResult> = {
    description: 'Read the current high-signal WallStreetBets discovery packet: ranked posts and useful comments.',
    execute: async () => {
      const result = await runRead(
        'search_reddit',
        () => searchRedditResearch(
          env,
          now,
          options.fetcher,
        ),
      )
      return textResult(result)
    },
    executionMode: 'sequential',
    label: 'Searching Reddit',
    name: 'search_reddit',
    parameters: RedditSearchParameters,
  }
  const coverage: AgentTool<typeof RecentCoverageParameters, RecentTickerCoverage[]> = {
    description: 'Read prior Spice recommendations for exact tickers over a chosen calendar-day lookback. Use this before repeating or updating a thesis.',
    execute: async (_toolCallId, params) => {
      const result = await runRead(
        'get_recent_coverage',
        () => searchRecentTickerCoverage(
          env,
          params.tickers,
          params.daysAgo,
          now,
        ),
      )
      return textResult(result)
    },
    executionMode: 'sequential',
    label: 'Reading recent coverage',
    name: 'get_recent_coverage',
    parameters: RecentCoverageParameters,
  }
  const metrics = createMarketMetricsReadTool(env)
  const readMetrics = metrics.execute
  metrics.execute = (...args) => runRead(metrics.name, () => readMetrics(...args))
  const optionContracts = createOptionContractFindTool(env)
  const findOptionContracts = optionContracts.execute
  optionContracts.execute = (...args) => runRead(optionContracts.name, () => findOptionContracts(...args))
  const quotes = createInstrumentQuoteReadTool(env)
  const readQuotes = quotes.execute
  quotes.execute = (...args) => runRead(quotes.name, () => readQuotes(...args))
  return [
    ...(options.includeReddit === false ? [] : [reddit]),
    coverage,
    metrics,
    optionContracts,
    quotes,
  ]
}
