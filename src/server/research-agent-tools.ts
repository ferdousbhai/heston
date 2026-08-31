import { type AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

import { EquitySymbolType } from '../domain/instrument'
import { textResult } from './agent-tool-result'
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
  const coverage: AgentTool<typeof RecentCoverageParameters, RecentTickerCoverage[]> = {
    description: 'Prior Spice ideas for these tickers within daysAgo; today is excluded.',
    execute: async (_toolCallId, params) => textResult(await searchRecentTickerCoverage(
      env,
      params.tickers,
      params.daysAgo,
      now,
    )),
    label: 'Reading recent coverage',
    name: 'get_recent_coverage',
    parameters: RecentCoverageParameters,
  }
  return [
    ...(options.includeReddit === false ? [] : [reddit]),
    coverage,
    createMarketMetricsReadTool(env),
    createOptionContractFindTool(env),
    createInstrumentQuoteReadTool(env),
  ].map(withRunStep)
}
