import { afterEach, describe, expect, it, vi } from 'vitest'
import { Compile } from 'typebox/compile'

import { JsonObjectSchema, type JsonObject } from '../src/domain/json-payload'
import {
  DailyRecommendationsSubmissionSchema,
  runDailyResearchAgent,
  type DailyRecommendationsSubmission,
} from '../src/server/research-agent'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { markdownBrowser } from './fake-browser'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { unsupportedAi } from './fake-ai'

const NOW = new Date('2026-08-28T13:30:00.000Z')
const CITED_URL = 'https://example.com/nvidia-supply'
/** What the stub browser returns for CITED_URL, so cited quotes have a retained page to match. */
const CITED_MARKDOWN = '# NVIDIA\n\nNVIDIA signed a multi-year supply agreement with a hyperscaler.'

function submission(): DailyRecommendationsSubmission {
  return {
    catalysts: [],
    sources: [{
      context: 'A signed supply agreement improves near-term demand visibility.',
      sourceUrl: CITED_URL,
      title: 'NVIDIA signs supply agreement',
    }],
    title: 'Selective convexity',
    summary: 'One company-specific setup has a timely catalyst and a falsifiable risk.',
    regime: 'Selective',
    regimeDetail: 'Prefer company-specific catalysts with defined downside.',
    recommendations: [{
      description: 'The signed agreement improves visibility while option premium remains usable.',
      direction: 'bullish',
      evidence: [{ quote: 'signed a multi-year supply agreement', sourceIndex: 0 }],
      headline: 'Signed supply terms improve demand visibility',
      recommendedOrder: {
        kind: 'equity-option',
        legs: [{
          action: 'Buy to Open',
          contract: { expiry: '2026-10-16', optionType: 'C', strike: 225, underlying: 'NVDA' },
          instrumentType: 'Equity Option',
        }],
      },
      risk: 'Delivery timing slips or contracted volume fails to convert to revenue.',
      sourceIndices: [0],
      symbol: 'NVDA',
    }],
    links: [{
      description: 'Contains the concrete agreement terms.',
      recommendationIndex: 0,
      sourceIndex: 0,
      title: 'NVIDIA supply agreement',
    }],
  }
}

function providerToolCall(
  name: string,
  args: JsonObject,
  status: string | null = 'completed',
  nativeSearches: { web?: string; x?: string } = {},
) {
  const response = {
    output: [
      ...(nativeSearches.x ? [{ type: 'x_search_call', status: nativeSearches.x }] : []),
      ...(nativeSearches.web ? [{ type: 'web_search_call', status: nativeSearches.web }] : []),
      { type: 'function_call', call_id: `${name}-1`, name, arguments: JSON.stringify(args) },
    ],
  }
  return status === null ? response : { ...response, status }
}

function providerReport(
  status: string | null = 'completed',
  report: DailyRecommendationsSubmission = submission(),
) {
  const response = {
    output: [
      {
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify(report),
        }],
      },
    ],
  }
  return status === null ? response : { ...response, status }
}

function environment(
  markdown = CITED_MARKDOWN,
  publishedLinks: Array<{
    dailyRecommendationsId: string
    firstPublishedAt: string
    url: string
  }> = [],
) {
  const secret = (value: string): SecretsStoreSecret => ({ get: async () => value })
  return {
    AI: {
      ...unsupportedAi(),
      // SAFETY: this test path calls only the documented getUrl method.
      gateway: () => ({ getUrl: async () => 'https://gateway.example/spice/grok' }) as AiGateway,
    },
    AI_GATEWAY_TOKEN: secret('gateway-token'),
    BROWSER: markdownBrowser(markdown),
    DB: {
      ...unsupportedDatabase(),
      prepare: (sql: string) => ({
        ...unsupportedStatement(),
        bind: () => ({
          ...unsupportedStatement(),
          // SAFETY: The agent's only `all` query selects this exact history-row projection;
          // D1's generic result type is chosen by that caller just as it is in production.
          all: async <T = unknown>() => d1Result(
            (sql.includes('FROM recommendation_links') ? publishedLinks : []) as T[],
          ),
        }),
        first: async () => null,
      }),
    },
    REDDIT_CLIENT_ID: secret('reddit-id'),
    REDDIT_CLIENT_SECRET: secret('reddit-secret'),
    XAI_API_KEY: secret('xai-key'),
  }
}

function agentFetcher(
  status: string | null = 'completed',
  nativeSearches: { web?: string; x?: string } = { web: 'completed', x: 'completed' },
) {
  const providerResponses = [
    providerToolCall('read_daily_recommendations', {}, status, nativeSearches),
    providerToolCall('read_catalysts', { horizonDays: 180, symbols: ['NVDA'] }, status),
    providerToolCall('read_market_metrics', { symbols: ['NVDA'] }, status),
    providerToolCall('get_recent_coverage', { daysAgo: 14, tickers: ['NVDA'] }, status),
    providerToolCall('read_page', { url: CITED_URL }, status),
    providerToolCall('check_recommendation_links', { urls: [CITED_URL] }, status),
    providerReport(status),
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

afterEach(() => {
  resetBrokerApi()
})

describe('daily research Pi agent boundary', () => {
  it('asserts the structured report without cleaning or coercing it', () => {
    const validator = Compile(DailyRecommendationsSubmissionSchema)

    expect(() => validator.Parse({ ...submission(), title: 42 })).toThrow()
    expect(() => validator.Parse({ ...submission(), unexpected: true })).toThrow()
    expect(() => validator.Parse({
      ...submission(),
      recommendations: [{
        ...submission().recommendations[0]!,
        recommendedOrder: {
          kind: 'equity',
          legs: [{ action: 'Buy to Open', instrumentType: 'Equity', symbol: 'NVDA' }],
        },
      }],
    })).not.toThrow()
  })

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

    expect(result.submission.recommendations[0]?.symbol).toBe('NVDA')
    expect(bodies).toHaveLength(8)
    expect(bodies[0]?.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'web_search' }),
      expect.objectContaining({ type: 'x_search' }),
      expect.objectContaining({ name: 'read_daily_recommendations', type: 'function' }),
      expect.objectContaining({ name: 'check_recommendation_links', type: 'function' }),
      expect.objectContaining({ name: 'read_catalysts', type: 'function' }),
      expect.objectContaining({ name: 'read_market_metrics', type: 'function' }),
      expect.objectContaining({ name: 'read_price_history', type: 'function' }),
      expect.objectContaining({ name: 'get_recent_coverage', type: 'function' }),
      expect.objectContaining({ name: 'find_option_contracts', type: 'function' }),
      expect.objectContaining({ name: 'read_instrument_quotes', type: 'function' }),
    ]))
    expect(bodies[0]?.tools).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'submit_daily_report', type: 'function' }),
    ]))
    // A research turn carries the tools and no schema; forcing both is what produced a
    // report full of "placeholder" from a model that had decided to use tools.
    expect(bodies[0]).not.toHaveProperty('text')
    expect(bodies[0]?.tool_choice).toBe('auto')
    expect(bodies[7]?.text).toEqual(expect.objectContaining({
      format: expect.objectContaining({ name: 'daily_recommendations', type: 'json_schema' }),
    }))
    expect(bodies[7]).not.toHaveProperty('tools')
    expect(bodies[0]?.tools).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ingest_wsb', type: 'function' }),
    ]))
    expect(bodies[0]?.tools).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'record_catalyst', type: 'function' }),
    ]))
    expect(JSON.stringify(bodies[1]?.input)).toContain('function_call_output')
    // Citations are now bound deterministically after the run, so the prompt no longer has
    // to be trusted for them: losing that instruction makes the binder drop recommendations loudly
    // rather than publish unsupported ones. What is still pinned is the rule nothing
    // downstream can enforce — the discovery venues must never surface publicly.
    expect(JSON.stringify(bodies[0]?.input)).toContain('X and Reddit never appear in public prose or sources')
    expect(JSON.stringify(bodies[0]?.input)).toContain('reddit_discovery_packet')
    expect(JSON.stringify(bodies[0]?.input)).toContain('at most 10 ticker candidates')
    expect(JSON.stringify(bodies[0]?.input)).toContain('Read current state')
    expect(JSON.stringify(bodies[0]?.input)).toContain('Default to an option order')
    expect(JSON.stringify(bodies[0]?.input)).toContain('Use equity only')
    expect(JSON.stringify(bodies[0]?.input)).toContain('recommendedOrder')
    expect(JSON.stringify(bodies[0]?.input)).toContain('sharp market column')
    expect(JSON.stringify(bodies[7]?.text)).toContain('catalysts')
    expect(JSON.stringify(bodies[0]?.input)).not.toContain('yahoo_mover_packet')
    expect(JSON.stringify(bodies[0]?.input)).not.toContain('codex_catalyst_packet')
    expect(JSON.stringify(bodies[0]?.input)).not.toContain('x_discovery_packet')
    expect(steps).toEqual([
      'reddit-context',
      'model-1', 'tool-1-read_daily_recommendations',
      'model-2', 'tool-2-read_catalysts',
      'model-3', 'tool-3-read_market_metrics',
      'model-4', 'tool-4-get_recent_coverage',
      'model-5', 'tool-5-read_page',
      'model-6', 'tool-6-check_recommendation_links',
      'model-7', 'model-8',
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

    expect(replayed.submission.recommendations[0]?.symbol).toBe('NVDA')
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

  it('returns a page-verified catalyst in the same structured output as recommendations', async () => {
    setBrokerApi(stubBroker())
    const withCatalyst: DailyRecommendationsSubmission = {
      ...submission(),
      catalysts: [{
        date: '2026-09-15',
        description: null,
        kind: 'investor-event',
        sourceIndex: 0,
        symbol: 'NVDA',
        timing: 'unknown',
        title: 'NVIDIA investor event',
      }],
    }
    const providerResponses = [
      providerToolCall('read_page', { url: CITED_URL }, 'completed', {
        web: 'completed', x: 'completed',
      }),
      providerToolCall('check_recommendation_links', { urls: [CITED_URL] }),
      providerReport(),
      providerReport('completed', withCatalyst),
    ]
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/responses')) return Response.json(providerResponses.shift())
      if (url.includes('/api/v1/access_token')) return Response.json({ access_token: 'reddit-token' })
      if (url.includes('/r/wallstreetbets/hot')) return Response.json({ data: { children: [] } })
      throw new Error(`Unexpected request: ${url}`)
    })

    const result = await runDailyResearchAgent(
      environment(`${CITED_MARKDOWN}\n\nThe investor event is September 15, 2026.`),
      { now: NOW, runId: 'daily-run' },
      fetcher,
    )

    expect(result.submission.catalysts).toEqual([expect.objectContaining({
      date: '2026-09-15',
      symbol: 'NVDA',
    })])
  })

  it('refuses a submission whose quote is in no page the run read, then fails visibly', async () => {
    const broker = stubBroker()
    broker.tastyRequest.mockResolvedValue({ data: { items: [{ symbol: 'NVDA' }] } })
    setBrokerApi(broker)
    // The model submits without ever calling read_page, so nothing backs the quote. It is
    // told what failed and given two more turns before the run gives up loudly, which is
    // the whole reason the binder runs inside the loop rather than after it.
    const providerResponses = [
      providerToolCall('read_daily_recommendations', {}, 'completed', { web: 'completed', x: 'completed' }),
      providerReport(), providerReport(), providerReport(),
      providerReport(), providerReport(), providerReport(),
    ]
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/responses')) return Response.json(providerResponses.shift())
      if (url.includes('/api/v1/access_token')) return Response.json({ access_token: 'reddit-token' })
      if (url.includes('/r/wallstreetbets/hot')) return Response.json({ data: { children: [] } })
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(runDailyResearchAgent(environment(), { now: NOW, runId: 'daily-run' }, fetcher))
      .rejects.toThrow('DailyResearchAgentSubmission')
    expect(providerResponses).toHaveLength(0)
  })

  it('keeps private discovery venues out of published recommendations and reader links', async () => {
    setBrokerApi(stubBroker())
    const socialUrl = 'https://x.com/nvidia/status/123'
    const socialSubmission: DailyRecommendationsSubmission = {
      ...submission(),
      sources: [{ ...submission().sources[0], sourceUrl: socialUrl }],
    }
    const providerResponses = [
      providerToolCall('read_page', { url: socialUrl }, 'completed', {
        web: 'completed', x: 'completed',
      }),
      providerReport(), providerReport('completed', socialSubmission),
      providerReport(), providerReport('completed', socialSubmission),
      providerReport(), providerReport('completed', socialSubmission),
    ]
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/responses')) return Response.json(providerResponses.shift())
      if (url.includes('/api/v1/access_token')) return Response.json({ access_token: 'reddit-token' })
      if (url.includes('/r/wallstreetbets/hot')) return Response.json({ data: { children: [] } })
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(runDailyResearchAgent(environment(), {
      now: NOW, runId: 'daily-run',
    }, fetcher)).rejects.toThrow('private discovery venue')
    expect(providerResponses).toHaveLength(0)
  })

  it('refuses a reader link that appeared in an earlier daily recommendation', async () => {
    setBrokerApi(stubBroker())
    const providerResponses = [
      providerToolCall('read_page', { url: CITED_URL }, 'completed', {
        web: 'completed', x: 'completed',
      }),
      providerToolCall('check_recommendation_links', { urls: [CITED_URL] }),
      providerReport(), providerReport(), providerReport(), providerReport(),
      providerReport(), providerReport(),
    ]
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/responses')) return Response.json(providerResponses.shift())
      if (url.includes('/api/v1/access_token')) return Response.json({ access_token: 'reddit-token' })
      if (url.includes('/r/wallstreetbets/hot')) return Response.json({ data: { children: [] } })
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(runDailyResearchAgent(environment(CITED_MARKDOWN, [{
      dailyRecommendationsId: 'recommendations-2026-08-27',
      firstPublishedAt: '2026-08-27T13:30:00.000Z',
      url: CITED_URL,
    }]), { now: NOW, runId: 'daily-run' }, fetcher)).rejects.toThrow('previously published')
    expect(providerResponses).toHaveLength(0)
  })

  it('accepts a preview image only when its URL appears on the retained page', async () => {
    setBrokerApi(stubBroker())
    const previewImageUrl = 'https://images.example.com/nvidia.jpg'
    const withPreview: DailyRecommendationsSubmission = {
      ...submission(),
      links: [{ ...submission().links[0], previewImageUrl }],
    }
    const providerResponses = [
      providerToolCall('read_page', { url: CITED_URL }, 'completed', {
        web: 'completed', x: 'completed',
      }),
      providerToolCall('check_recommendation_links', { urls: [CITED_URL] }),
      providerReport(), providerReport('completed', withPreview),
    ]
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/responses')) return Response.json(providerResponses.shift())
      if (url.includes('/api/v1/access_token')) return Response.json({ access_token: 'reddit-token' })
      if (url.includes('/r/wallstreetbets/hot')) return Response.json({ data: { children: [] } })
      throw new Error(`Unexpected request: ${url}`)
    })

    const result = await runDailyResearchAgent(
      environment(`${CITED_MARKDOWN}\n\n![Factory](${previewImageUrl})`),
      { now: NOW, runId: 'daily-run' },
      fetcher,
    )

    expect(result.submission.links[0]?.previewImageUrl).toBe(previewImageUrl)
  })

  it('refuses mismatched recommended-order legs and lets the model correct them', async () => {
    setBrokerApi(stubBroker())
    const invalid: DailyRecommendationsSubmission = {
      ...submission(),
      recommendations: [{
        ...submission().recommendations[0]!,
        recommendedOrder: {
          kind: 'equity',
          legs: [{ action: 'Buy to Open', instrumentType: 'Equity', symbol: 'META' }],
        },
      }],
    }
    const providerResponses = [
      providerToolCall('read_page', { url: CITED_URL }, 'completed', {
        web: 'completed', x: 'completed',
      }),
      providerToolCall('check_recommendation_links', { urls: [CITED_URL] }),
      providerReport(), providerReport('completed', invalid),
      providerReport(), providerReport(),
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

    const result = await runDailyResearchAgent(environment(), {
      now: NOW, runId: 'daily-run',
    }, fetcher)

    expect(result.submission.recommendations[0]?.recommendedOrder.kind).toBe('equity-option')
    expect(JSON.stringify(bodies[4]?.input)).toContain('equity leg must match the recommendation symbol')
    expect(providerResponses).toHaveLength(0)
  })

  it('refuses a report without one reader link per recommendation', async () => {
    setBrokerApi(stubBroker())
    const invalid: DailyRecommendationsSubmission = { ...submission(), links: [] }
    const providerResponses = [
      providerToolCall('read_page', { url: CITED_URL }, 'completed', {
        web: 'completed', x: 'completed',
      }),
      providerToolCall('check_recommendation_links', { urls: [CITED_URL] }),
      providerReport(), providerReport('completed', invalid),
      providerReport(), providerReport(),
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

    const result = await runDailyResearchAgent(environment(), {
      now: NOW, runId: 'daily-run',
    }, fetcher)

    expect(result.submission.links).toHaveLength(1)
    expect(JSON.stringify(bodies[4]?.input)).toContain(
      'links must contain exactly one entry per recommendation',
    )
    expect(providerResponses).toHaveLength(0)
  })

  it('refuses an empty report from a run that read nothing', async () => {
    const broker = stubBroker()
    broker.tastyRequest.mockResolvedValue({ data: { items: [{ symbol: 'NVDA' }] } })
    setBrokerApi(broker)
    // A schema-shaped report costs the model nothing to produce. One reached production with
    // "placeholder" in every field on the first turn, no tool call behind it, and published:
    // sifting no recommendations rejected nothing. Concluding the day is quiet requires having looked.
    const empty: DailyRecommendationsSubmission = {
      ...submission(),
      recommendations: [],
      links: [],
      regime: 'placeholder',
      regimeDetail: 'placeholder',
      sources: [],
      summary: 'placeholder',
      title: 'placeholder',
    }
    const providerResponses = [
      providerToolCall('read_daily_recommendations', {}, 'completed', { web: 'completed', x: 'completed' }),
      providerReport('completed', empty), providerReport('completed', empty),
      providerReport('completed', empty), providerReport('completed', empty),
      providerReport('completed', empty), providerReport('completed', empty),
    ]
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/responses')) return Response.json(providerResponses.shift())
      if (url.includes('/api/v1/access_token')) return Response.json({ access_token: 'reddit-token' })
      if (url.includes('/r/wallstreetbets/hot')) return Response.json({ data: { children: [] } })
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(runDailyResearchAgent(environment(), { now: NOW, runId: 'daily-run' }, fetcher))
      .rejects.toThrow('no page was read this run')
    expect(providerResponses).toHaveLength(0)
  })

  it('fails visibly when the model completes without running native X search', async () => {
    const broker = stubBroker()
    broker.tastyRequest.mockResolvedValue({ data: { items: [{ symbol: 'NVDA' }] } })
    setBrokerApi(broker)
    const providerResponses = [
      providerToolCall('read_daily_recommendations', {}, 'completed', { web: 'completed' }),
      providerReport(), providerReport(), providerReport(),
      providerReport(), providerReport(), providerReport(),
    ]
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.endsWith('/responses')) return Response.json(providerResponses.shift())
      if (url.includes('/api/v1/access_token')) return Response.json({ access_token: 'reddit-token' })
      if (url.includes('/r/wallstreetbets/hot')) return Response.json({ data: { children: [] } })
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(runDailyResearchAgent(environment(), {
      now: NOW, runId: 'daily-run',
    }, fetcher)).rejects.toThrow('native X Search was not completed')
  })

  it('fails visibly when the native X call does not complete', async () => {
    setBrokerApi(stubBroker())
    const { fetcher } = agentFetcher('completed', { web: 'completed', x: 'failed' })

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
    expect(bodies).toHaveLength(0)
  })

  it('carries on when a research tool refuses a call', async () => {
    const broker = stubBroker()
    broker.tastyRequest.mockRejectedValue(new Error('provider unavailable'))
    setBrokerApi(broker)
    const { fetcher } = agentFetcher()

    // A refused call is a message to the model, not the end of the day. One failure used to
    // abort the whole daily run, which is how a cashtag reaching a tool cost an afternoon;
    // a provider that keeps failing still stops it once the error budget is spent.
    const agent = await runDailyResearchAgent(environment(), { now: NOW, runId: 'daily-run' }, fetcher)

    expect(agent.submission.recommendations).toHaveLength(1)
  })

  it('rejects a provider response without a completed status', async () => {
    setBrokerApi(stubBroker())
    const { fetcher } = agentFetcher(null)

    await expect(runDailyResearchAgent(environment(), { now: NOW, runId: 'daily-run' }, fetcher))
      .rejects.toThrow('DailyResearchAgentResponse:status-missing')
  })
})
