import { Type } from '@earendil-works/pi-ai'
import { type AgentTool } from '@earendil-works/pi-agent-core'

import { CatalystSchema, marketDate } from '../domain/catalyst'
import { toError } from '../domain/failure'
import { EQUITY_SYMBOL_PATTERN } from '../domain/instrument'
import { textResult } from './agent-tool-result'
import { type AppEnv } from './env'
import { marketMoverResearch } from './research-market-movers'
import { searchRecentTickerCoverage, type RecentTickerCoverage } from './research-coverage'
import { type ResearchSourceItem } from './research-contracts'
import { collectRedditSources } from './research-reddit'
import { readStoredSecret } from './secrets'
import {
  createInstrumentQuoteReadTool,
  createMarketMetricsReadTool,
  createOptionContractFindTool,
  type MarketMetricsReadResult,
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
  discussions: ResearchSourceItem[]
  evidence: Array<ResearchSourceItem & { evidenceIndex: number }>
  fetchedAt: string
  redditError?: string
  source: 'reddit' | 'fallback'
}

export interface ResearchAgentToolCapture {
  marketMetrics: MarketMetricsReadResult['metrics']
}

export interface ResearchAgentToolOptions {
  capture?: ResearchAgentToolCapture
  fetcher?: typeof fetch
  includeReddit?: boolean
  now?: Date
  runStep?: <T>(name: string, task: () => Promise<T>) => Promise<T>
}

function publicDiscussionEvidence(items: readonly ResearchSourceItem[]): ResearchSourceItem[] {
  return items.flatMap((item) => {
    const linkedPages = item.linkedPages
      ?? (item.outbound?.excerpt ? [{
        ...item.outbound,
        excerpt: item.outbound.excerpt,
        title: item.outbound.title ?? item.outbound.label,
      }] : [])
    return linkedPages.map((link) => ({
      context: link.excerpt,
      publishedAt: item.publishedAt,
      source: `Linked-page discovery · ${link.label}`,
      title: link.title,
      url: link.url,
    }))
  })
}

async function recentCodexEvidence(env: AppEnv, now: Date): Promise<ResearchSourceItem[]> {
  if (!env.DB) return []
  const updatedAfter = new Date(now.getTime() - 7 * 24 * 60 * 60_000).toISOString()
  const rows = await env.DB.prepare(
    `SELECT id, symbol, kind, title, description, event_date AS date, timing, confidence,
       source_label AS source, source_url AS "sourceUrl", updated_at AS "updatedAt"
     FROM codex_web_catalysts
     WHERE updated_at >= ? AND event_date >= ?
     ORDER BY event_date ASC, symbol ASC
     LIMIT 100`,
  ).bind(updatedAfter, marketDate(now)).all()
  return CatalystSchema.array().parse(rows.results ?? []).map((catalyst) => ({
    context: `Scheduled ${catalyst.kind} on ${catalyst.date} (${catalyst.timing}). ${catalyst.description ?? catalyst.title}`,
    publishedAt: catalyst.updatedAt,
    source: catalyst.source,
    symbols: [catalyst.symbol],
    title: catalyst.title,
    url: catalyst.sourceUrl,
  }))
}

async function fallbackEvidence(env: AppEnv, now: Date): Promise<ResearchSourceItem[]> {
  const [movers, codex] = await Promise.all([
    marketMoverResearch().collect(now).catch(() => []),
    recentCodexEvidence(env, now).catch(() => []),
  ])
  return [...movers, ...codex]
}

function cleanError(error: Error | undefined): string {
  return (error?.message ?? 'Reddit unavailable')
    .replaceAll(/[^A-Za-z0-9:._-]/g, '_')
    .slice(0, 160)
}

export async function searchRedditResearch(
  env: AppEnv,
  now = new Date(),
  fetcher: typeof fetch = fetch,
  useFallback = false,
): Promise<RedditResearchResult> {
  try {
    if (!env.REDDIT_CLIENT_ID || !env.REDDIT_CLIENT_SECRET) throw new Error('RedditResearchUnavailable')
    const [clientId, clientSecret] = await Promise.all([
      readStoredSecret(env.REDDIT_CLIENT_ID, 'REDDIT_CLIENT_ID'),
      readStoredSecret(env.REDDIT_CLIENT_SECRET, 'REDDIT_CLIENT_SECRET'),
    ])
    const discussions = await collectRedditSources({ clientId, clientSecret }, fetcher)
    return {
      discussions,
      evidence: publicDiscussionEvidence(discussions).map((item, evidenceIndex) => ({ evidenceIndex, ...item })),
      fetchedAt: now.toISOString(),
      source: 'reddit',
    }
  } catch (error) {
    if (!useFallback) throw error
    const redditError = cleanError(toError(error))
    console.error(JSON.stringify({ event: 'DailyResearchRedditFallback', error: redditError }))
    return {
      discussions: [],
      evidence: (await fallbackEvidence(env, now)).map((item, evidenceIndex) => ({ evidenceIndex, ...item })),
      fetchedAt: now.toISOString(),
      redditError,
      source: 'fallback',
    }
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
    description: 'Read the current high-signal WallStreetBets discovery packet: ranked posts, useful comments, and fetched outbound pages.',
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
  metrics.execute = async (...args) => {
    const result = await runRead(metrics.name, () => readMetrics(...args))
    if (options.capture) options.capture.marketMetrics.push(...result.details.metrics)
    return result
  }
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
