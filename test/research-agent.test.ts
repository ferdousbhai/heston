import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { JsonObjectSchema, type JsonObject } from '../src/domain/json-payload'
import {
  runDailyResearchAgent,
  type DailyResearchSubmission,
} from '../src/server/research-agent'
import { resetMarketMoverResearch, setMarketMoverResearch } from '../src/server/research-market-movers'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { unsupportedAi } from './fake-ai'

const NOW = new Date('2026-08-28T13:30:00.000Z')
const CITED_URL = 'https://example.com/nvidia-supply'

function submission(): DailyResearchSubmission {
  return {
    sources: [{
      context: 'A signed supply agreement improves near-term demand visibility.',
      sourceUrl: CITED_URL,
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
    readingList: [{
      description: 'Contains the concrete agreement terms.',
      sourceIndex: 0,
      title: 'NVIDIA supply agreement',
    }],
  }
}

function providerToolCall(
  name: string,
  args: JsonObject,
  status: string | null = 'completed',
) {
  const response = {
    output: [
      { type: 'function_call', call_id: `${name}-1`, name, arguments: JSON.stringify(args) },
    ],
  }
  return status === null ? response : { ...response, status }
}

function providerReport(
  status: string | null = 'completed',
) {
  const response = {
    output: [
      {
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify(submission()),
        }],
      },
    ],
  }
  return status === null ? response : { ...response, status }
}

function providerXContext(
  status: string | null = 'completed',
  xSearchStatus: string | null = null,
  serverSideTools = 1,
) {
  const response = {
    output: [
      ...(xSearchStatus ? [{ type: 'x_search_call', status: xSearchStatus }] : []),
      {
        type: 'message',
        content: [{
          type: 'output_text',
          text: 'NVDA has a scheduled product event worth verifying.',
        }],
      },
    ],
    usage: { num_server_side_tools_used: serverSideTools },
  }
  return status === null ? response : { ...response, status }
}

function environment() {
  const secret = (value: string): SecretsStoreSecret => ({ get: async () => value })
  const all = async () => d1Result([])
  const bind = () => ({ ...unsupportedStatement(), all })
  return {
    AI: {
      ...unsupportedAi(),
      // SAFETY: this test path calls only the documented getUrl method.
      gateway: () => ({ getUrl: async () => 'https://gateway.example/spice/grok' }) as AiGateway,
    },
    AI_GATEWAY_TOKEN: secret('gateway-token'),
    DB: { ...unsupportedDatabase(), prepare: () => ({ ...unsupportedStatement(), bind }) },
    REDDIT_CLIENT_ID: secret('reddit-id'),
    REDDIT_CLIENT_SECRET: secret('reddit-secret'),
    XAI_API_KEY: secret('xai-key'),
  }
}

function agentFetcher(
  status: string | null = 'completed',
  xSearchStatus: string | null = 'completed',
  serverSideTools = xSearchStatus === null ? 0 : 1,
) {
  const providerResponses = [
    providerXContext(status, xSearchStatus, serverSideTools),
    providerToolCall('read_market_metrics', { symbols: ['NVDA'] }, status),
    providerToolCall('get_recent_coverage', { daysAgo: 14, tickers: ['NVDA'] }, status),
    providerReport(status),
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

beforeEach(() => {
  setMarketMoverResearch({
    collect: async (now = NOW) => ({
      fetchedAt: now.toISOString(),
      movers: [],
      source: 'yahoo',
      status: 'available',
      unavailableCategories: [],
    }),
  })
})

afterEach(() => {
  resetBrokerApi()
  resetMarketMoverResearch()
})

describe('daily research Pi agent boundary', () => {
  it('gives Pi Reddit context before it chooses candidates and uses research tools', async () => {
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
    expect(bodies).toHaveLength(4)
    expect(bodies[0]?.tools).toEqual([{ from_date: '2026-03-01', to_date: '2026-08-29', type: 'x_search' }])
    expect(bodies[0]?.tool_choice).toBe('required')
    expect(bodies[0]).not.toHaveProperty('text')
    expect(bodies[1]?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'web_search' }),
      expect.objectContaining({ type: 'x_search' }),
      expect.objectContaining({ name: 'read_market_metrics', type: 'function' }),
      expect.objectContaining({ name: 'get_recent_coverage', type: 'function' }),
      expect.objectContaining({ name: 'find_option_contracts', type: 'function' }),
      expect.objectContaining({ name: 'read_instrument_quotes', type: 'function' }),
    ]))
    expect(bodies[1]?.tools).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'submit_daily_report', type: 'function' }),
    ]))
    expect(bodies[1]?.text).toEqual(expect.objectContaining({
      format: expect.objectContaining({ name: 'daily_research_report', type: 'json_schema' }),
    }))
    expect(bodies[1]?.tool_choice).toBe('auto')
    expect(bodies[1]?.tools).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'search_reddit', type: 'function' }),
    ]))
    expect(JSON.stringify(bodies[2]?.input)).toContain('function_call_output')
    expect(JSON.stringify(bodies[1]?.input)).toContain('Not Found page is not evidence')
    expect(JSON.stringify(bodies[1]?.input)).toContain('Every material factual claim')
    expect(JSON.stringify(bodies[1]?.input)).toContain('reopen every selected source page')
    expect(JSON.stringify(bodies[1]?.input)).toContain('reddit_discovery_packet')
    expect(JSON.stringify(bodies[1]?.input)).toContain('yahoo_mover_packet')
    expect(JSON.stringify(bodies[1]?.input)).toContain('codex_catalyst_packet')
    expect(JSON.stringify(bodies[1]?.input)).toContain('x_discovery_packet')
    expect(steps).toEqual([
      'reddit-context', 'yahoo-movers', 'codex-context', 'x-context',
      'model-1', 'tool-1-read_market_metrics',
      'model-2', 'tool-2-get_recent_coverage',
      'model-3',
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
    expect(second.fetcher).not.toHaveBeenCalled()
    expect(broker.tastyRequest).toHaveBeenCalledTimes(1)
    expect([...cached.keys()]).not.toContain(expect.stringContaining('submit_daily_report'))
  })

  it('accepts the structured report after required discovery and local research', async () => {
    const broker = stubBroker()
    broker.tastyRequest.mockResolvedValue({ data: { items: [{ symbol: 'NVDA' }] } })
    setBrokerApi(broker)
    const { fetcher } = agentFetcher()

    await expect(runDailyResearchAgent(environment(), { now: NOW, runId: 'daily-run' }, fetcher))
      .resolves.toEqual(expect.objectContaining({ submission: expect.any(Object) }))
  })

  it('accepts dedicated X usage when xAI omits the native call item', async () => {
    const broker = stubBroker()
    broker.tastyRequest.mockResolvedValue({ data: { items: [{ symbol: 'NVDA' }] } })
    setBrokerApi(broker)
    const { fetcher } = agentFetcher('completed', null, 1)

    await expect(runDailyResearchAgent(environment(), { now: NOW, runId: 'daily-run' }, fetcher))
      .resolves.toEqual(expect.objectContaining({ submission: expect.any(Object) }))
  })

  it('fails visibly when the model completes without running native X search', async () => {
    const broker = stubBroker()
    broker.tastyRequest.mockResolvedValue({ data: { items: [{ symbol: 'NVDA' }] } })
    setBrokerApi(broker)
    const { fetcher } = agentFetcher('completed', null)

    await expect(runDailyResearchAgent(environment(), {
      now: NOW, runId: 'daily-run',
    }, fetcher)).rejects.toThrow('DailyResearchAgentMissingXSearch')
  })

  it('fails visibly when the native X call does not complete', async () => {
    setBrokerApi(stubBroker())
    const { fetcher } = agentFetcher('completed', 'failed')

    await expect(runDailyResearchAgent(environment(), {
      now: NOW, runId: 'daily-run',
    }, fetcher)).rejects.toThrow('DailyResearchAgentXSearch:failed')
  })

  it('fails visibly when mandatory Reddit research is unavailable', async () => {
    setBrokerApi(stubBroker())
    const { bodies, fetcher } = agentFetcher()

    await expect(runDailyResearchAgent({
      ...environment(),
      REDDIT_CLIENT_ID: undefined,
    }, { now: NOW, runId: 'daily-run' }, fetcher)).rejects.toThrow('RedditResearchUnavailable')
    expect(bodies).toHaveLength(1)
  })

  it('fails immediately when a research tool fails', async () => {
    const broker = stubBroker()
    broker.tastyRequest.mockRejectedValue(new Error('provider unavailable'))
    setBrokerApi(broker)
    const { bodies, fetcher } = agentFetcher()

    await expect(runDailyResearchAgent(environment(), { now: NOW, runId: 'daily-run' }, fetcher))
      .rejects.toThrow('DailyResearchAgentTool:read_market_metrics')
    expect(bodies).toHaveLength(2)
  })

  it('rejects a provider response without a completed status', async () => {
    setBrokerApi(stubBroker())
    const { fetcher } = agentFetcher(null)

    await expect(runDailyResearchAgent(environment(), { now: NOW, runId: 'daily-run' }, fetcher))
      .rejects.toThrow('DailyResearchAgentResponse:status-missing')
  })
})
