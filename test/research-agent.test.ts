import { afterEach, describe, expect, it, vi } from 'vitest'

import { JsonObjectSchema, type JsonObject } from '../src/domain/json-payload'
import {
  runDailyResearchAgent,
  type DailyResearchSubmission,
} from '../src/server/research-agent'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { unsupportedAi } from './fake-ai'

const NOW = new Date('2026-08-28T13:30:00.000Z')
const CITED_URL = 'https://example.com/nvidia-supply'

function submission(): DailyResearchSubmission {
  return {
    sources: [{
      context: 'A signed supply agreement improves near-term demand visibility.',
      evidenceIndex: null,
      sourceUrl: CITED_URL,
      symbol: 'NVDA',
      title: 'NVIDIA signs supply agreement',
    }],
    title: 'Selective convexity',
    summary: 'One company-specific setup has a timely catalyst and a falsifiable risk.',
    regime: 'Selective',
    regimeDetail: 'Prefer company-specific catalysts with defined downside.',
    ideas: [{
      description: 'The signed agreement improves visibility while option premium remains usable.',
      direction: 'bullish',
      headline: 'Signed supply terms improve demand visibility',
      play: { expiration: '2026-10-16', optionType: 'call', strike: 225 },
      risk: 'Delivery timing slips or contracted volume fails to convert to revenue.',
      sourceIndices: [0],
      symbol: 'NVDA',
    }],
    readingList: [{ reason: 'Contains the concrete agreement terms.', sourceIndex: 0 }],
  }
}

function providerToolCall(
  name: string,
  args: JsonObject,
  usage: JsonObject = {},
  citedUrl?: string,
) {
  return {
    output: [
      ...(citedUrl ? [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'Research complete.',
          annotations: [{ type: 'url_citation', url: citedUrl }],
        }],
      }] : []),
      { type: 'function_call', call_id: `${name}-1`, name, arguments: JSON.stringify(args) },
    ],
    usage: { server_side_tool_usage_details: usage },
  }
}

function environment() {
  const secret = (value: string): SecretsStoreSecret => ({ get: async () => value })
  return {
    AI: {
      ...unsupportedAi(),
      // SAFETY: this test path calls only the documented getUrl method.
      gateway: () => ({ getUrl: async () => 'https://gateway.example/spice/grok' }) as AiGateway,
    },
    AI_GATEWAY_TOKEN: secret('gateway-token'),
    REDDIT_CLIENT_ID: secret('reddit-id'),
    REDDIT_CLIENT_SECRET: secret('reddit-secret'),
    XAI_API_KEY: secret('xai-key'),
  }
}

function agentFetcher(xSearches = 2) {
  const providerResponses = [
    providerToolCall('search_reddit', {}),
    providerToolCall('read_market_metrics', { symbols: ['NVDA'] }),
    providerToolCall('get_recent_coverage', { daysAgo: 14, tickers: ['NVDA'] }),
    providerToolCall('submit_daily_report', submission(), {
      web_search_calls: 1,
      x_search_calls: xSearches,
    }, CITED_URL),
  ]
  const bodies: JsonObject[] = []
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/responses')) {
      bodies.push(JsonObjectSchema.parse(JSON.parse(String(init?.body))))
      return Response.json(providerResponses.shift())
    }
    if (url.includes('/api/v1/access_token')) return Response.json({ access_token: 'reddit-token' })
    if (url.includes('/r/wallstreetbets/hot')) return Response.json({ data: { children: [] } })
    throw new Error(`Unexpected request: ${url}`)
  })
  return { bodies, fetcher }
}

afterEach(() => resetBrokerApi())

describe('daily research Pi agent boundary', () => {
  it('lets Pi choose candidates and iterate through Reddit, metrics, coverage, and submission tools', async () => {
    const broker = stubBroker()
    broker.tastyRequest.mockResolvedValue({
      data: { items: [{
        symbol: 'NVDA',
        'implied-volatility-index': '0.42',
        'implied-volatility-index-rank': '0.27',
        'implied-volatility-percentile': '0.38',
        'liquidity-rating': 5,
      }] },
    })
    setBrokerApi(broker)
    const { bodies, fetcher } = agentFetcher()
    const steps: string[] = []

    const result = await runDailyResearchAgent(environment(), {
      now: NOW,
      runId: 'daily-run',
      runStep: async (name, task) => {
        steps.push(name)
        return task()
      },
    }, fetcher)

    expect(result.submission.ideas[0]?.symbol).toBe('NVDA')
    expect(result.marketMetrics).toEqual([expect.objectContaining({ symbol: 'NVDA' })])
    expect(result.citations).toContain(CITED_URL)
    expect(result.xSearches).toBe(2)
    expect(bodies).toHaveLength(4)
    expect(bodies[0]?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'web_search' }),
      expect.objectContaining({ type: 'x_search' }),
      expect.objectContaining({ name: 'search_reddit', type: 'function' }),
      expect.objectContaining({ name: 'read_market_metrics', type: 'function' }),
      expect.objectContaining({ name: 'get_recent_coverage', type: 'function' }),
      expect.objectContaining({ name: 'find_option_contracts', type: 'function' }),
      expect.objectContaining({ name: 'read_instrument_quotes', type: 'function' }),
      expect.objectContaining({ name: 'submit_daily_report', type: 'function' }),
    ]))
    expect(JSON.stringify(bodies[1]?.input)).toContain('function_call_output')
    expect(JSON.stringify(bodies[0]?.input)).toContain('Not Found page is not evidence')
    expect(steps).toEqual([
      'model-1', 'tool-1-search_reddit',
      'model-2', 'tool-2-read_market_metrics',
      'model-3', 'tool-3-get_recent_coverage',
      'model-4',
    ])
  })

  it('rebuilds captures when Workflow replay returns cached read steps', async () => {
    const broker = stubBroker()
    broker.tastyRequest.mockResolvedValue({
      data: { items: [{ symbol: 'NVDA', 'implied-volatility-index': '0.42' }] },
    })
    setBrokerApi(broker)
    const cached = new Map<string, unknown>()
    const runStep = async <T>(name: string, task: () => Promise<T>): Promise<T> => {
      if (cached.has(name)) {
        // SAFETY: each deterministic Workflow step name is replayed with the same task/result type.
        return cached.get(name) as T
      }
      const result = await task()
      cached.set(name, result)
      return result
    }
    const first = agentFetcher()
    await runDailyResearchAgent(environment(), { now: NOW, runId: 'daily-run', runStep }, first.fetcher)
    const second = agentFetcher()

    const replayed = await runDailyResearchAgent(
      environment(),
      { now: NOW, runId: 'daily-run', runStep },
      second.fetcher,
    )

    expect(replayed.submission.ideas[0]?.symbol).toBe('NVDA')
    expect(replayed.marketMetrics).toEqual([expect.objectContaining({ symbol: 'NVDA' })])
    expect(replayed.evidence).toEqual([])
    expect(replayed.citations).toContain(CITED_URL)
    expect(second.fetcher).not.toHaveBeenCalled()
    expect(broker.tastyRequest).toHaveBeenCalledTimes(1)
    expect([...cached.keys()]).not.toContain(expect.stringContaining('submit_daily_report'))
  })

  it('requires native X research somewhere in the run', async () => {
    const broker = stubBroker()
    broker.tastyRequest.mockResolvedValue({ data: { items: [{ symbol: 'NVDA' }] } })
    setBrokerApi(broker)
    const { fetcher } = agentFetcher(0)

    await expect(runDailyResearchAgent(environment(), { now: NOW, runId: 'daily-run' }, fetcher))
      .rejects.toThrow('DailyResearchAgentMissingXSearch')
  })
})
