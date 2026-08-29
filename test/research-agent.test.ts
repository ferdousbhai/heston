import { describe, expect, it, vi } from 'vitest'

import { JsonObjectSchema } from '../src/domain/json-payload'
import {
  runDailyResearchAgent,
  type DailyResearchAgentRequest,
  type DailyResearchSubmission,
} from '../src/server/research-agent'
import { unsupportedAi } from './fake-ai'

const NOW = new Date('2026-08-28T13:30:00.000Z')
const CITED_URL = 'https://example.com/nvidia-supply'
const MODEL_ONLY_URL = 'https://example.com/model-only'

function submission(): DailyResearchSubmission {
  return {
    sources: [{
      context: 'A signed supply agreement improves near-term demand visibility.',
      evidenceIndex: null,
      sourceUrl: MODEL_ONLY_URL,
      symbol: 'NVDA',
      title: 'NVIDIA signs supply agreement',
    }],
    xCatalysts: [],
    redditCatalysts: [],
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
      thesisChange: '',
    }],
    marketMovers: [],
    readingList: [{ reason: 'Contains the concrete agreement terms.', sourceIndex: 0 }],
  }
}

function request(): DailyResearchAgentRequest {
  return {
    detectedMovers: [],
    evidence: [{
      context: 'NVIDIA signed a supply agreement.',
      source: 'Example wire',
      symbols: ['NVDA'],
      title: 'NVIDIA supply agreement',
      url: CITED_URL,
    }],
    marketMetrics: [{
      earningsDate: '2026-11-18', ivIndex: 0.42, ivPercentile: 38, ivRank: 27,
      liquidity: 5, name: 'NVIDIA', price: 180, symbol: 'NVDA',
    }],
    now: NOW,
    recentCoverage: [],
    redditEvidence: [],
    runId: 'daily-run',
  }
}

type ResearchIdeaCandidate = DailyResearchSubmission['ideas'][number]
type InvalidSubmission = Omit<DailyResearchSubmission, 'ideas'> & {
  ideas: Array<Omit<ResearchIdeaCandidate, 'direction'> & { direction: string }>
}

function providerResponse(
  argumentsValue: DailyResearchSubmission | InvalidSubmission,
  usage = { web_search_calls: 2, x_search_calls: 4 },
) {
  return {
    output: [{
      type: 'message',
      content: [{
        type: 'output_text',
        text: 'Research complete.',
        annotations: [{ type: 'url_citation', url: CITED_URL }],
      }],
    }, {
      type: 'function_call',
      call_id: 'submit-1',
      name: 'submit_daily_report',
      arguments: JSON.stringify(argumentsValue),
    }],
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
    XAI_API_KEY: secret('xai-key'),
  }
}

describe('daily research Pi agent boundary', () => {
  it('makes one Grok request with native search and the TypeBox submission tool', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe('https://gateway.example/spice/grok/v1/responses')
      const body = JsonObjectSchema.parse(JSON.parse(String(init?.body)))
      expect(body.model).toBe('grok-4.6')
      expect(body.tool_choice).toBe('required')
      expect(body).not.toHaveProperty('text')
      expect(body.tools).toEqual([
        { type: 'web_search' },
        { type: 'x_search', from_date: '2026-03-01', to_date: '2026-08-29' },
        expect.objectContaining({
          type: 'function',
          name: 'submit_daily_report',
          parameters: expect.objectContaining({ additionalProperties: false, type: 'object' }),
        }),
      ])
      expect(JSON.stringify(body.input)).toContain('NVIDIA signed a supply agreement')
      expect(JSON.stringify(body.input)).toContain('instead of sweeping or spending equal effort on every ticker')
      expect(JSON.stringify(body.input)).not.toContain('Maintained symbols:')
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer xai-key')
      expect(headers.get('cf-aig-collect-log-payload')).toBe('true')
      expect(JSON.parse(headers.get('cf-aig-metadata') ?? '{}')).toMatchObject({
        app: 'spice', feature: 'daily-research-agent', market_date: '2026-08-28', run_id: 'daily-run',
      })
      return Response.json(providerResponse(submission()))
    })
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      const result = await runDailyResearchAgent(environment(), request(), fetcher)

      expect(fetcher).toHaveBeenCalledOnce()
      expect(result.submission).toEqual(submission())
      expect(result).toMatchObject({ webSearches: 2, xSearches: 4 })
      expect(result.citations).toEqual(new Set([CITED_URL]))
      expect(result.citations).not.toContain(MODEL_ONLY_URL)
    } finally {
      info.mockRestore()
    }
  })

  it('lets Pi reject an invalid structured submission before execute receives it', async () => {
    const valid = submission()
    const invalid = {
      ...valid,
      ideas: valid.ideas.map((idea) => ({ ...idea, direction: 'cautiously bullish' })),
    }
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(providerResponse(invalid)))

    await expect(runDailyResearchAgent(environment(), request(), fetcher))
      .rejects.toThrow('DailyResearchAgentResponse:missing-submission')
  })

  it('requires the scheduled X research but lets Grok decide whether web search adds value', async () => {
    const noWeb = vi.fn<typeof fetch>(async () => Response.json(providerResponse(
      submission(),
      { web_search_calls: 0, x_search_calls: 4 },
    )))
    const noX = vi.fn<typeof fetch>(async () => Response.json(providerResponse(
      submission(),
      { web_search_calls: 2, x_search_calls: 0 },
    )))

    await expect(runDailyResearchAgent(environment(), request(), noWeb))
      .resolves.toMatchObject({ webSearches: 0, xSearches: 4 })
    await expect(runDailyResearchAgent(environment(), request(), noX))
      .rejects.toThrow('DailyResearchAgentMissingXSearch')
  })
})
