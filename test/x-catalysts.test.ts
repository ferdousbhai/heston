import { describe, expect, it, vi } from 'vitest'
import { JsonObjectSchema } from '../src/domain/json-payload'

import { canonicalXPostUrl, catalystResearchSymbols, discoverXCatalysts, parseXCatalystResponse } from '../src/server/x-catalysts'
import { unsupportedAi } from './fake-ai'

const NOW = new Date('2026-08-13T22:30:00.000Z')

function response(findings: unknown[], citations: string[]) {
  return {
    output: [{ type: 'message', content: [{
      type: 'output_text', text: JSON.stringify({ findings }),
      annotations: citations.map((url) => ({ type: 'url_citation', url })),
    }] }],
  }
}

describe('Grok X catalyst boundary', () => {
  it('does not cap Grok native X Search tool calls', async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const request = JsonObjectSchema.parse(JSON.parse(String(init?.body)))
      expect(request).not.toHaveProperty('max_tool_calls')
      expect(input).toBe('https://gateway.example/spice/grok/v1/responses')
      const headers = new Headers(init?.headers)
      expect(headers.get('cf-aig-collect-log')).toBe('true')
      expect(headers.get('cf-aig-collect-log-payload')).toBe('true')
      expect(JSON.parse(headers.get('cf-aig-metadata') ?? '{}')).toMatchObject({
        app: 'spice', feature: 'x-catalyst-research', market_date: '2026-08-13',
      })
      return Response.json(response([], []))
    })

    const secret = (value: string): SecretsStoreSecret => ({ get: async () => value })
    // SAFETY: discoverXCatalysts reaches only getUrl; every other fake AI method throws.
    await discoverXCatalysts({
      AI: {
        ...unsupportedAi(),
        gateway: () => ({ getUrl: async () => 'https://gateway.example/spice/grok' }) as AiGateway,
      },
      AI_GATEWAY_TOKEN: secret('gateway-token'),
      XAI_API_KEY: secret('xai-key'),
    }, ['AAPL'], NOW, fetcher)

    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('accepts only future watched catalysts backed by returned X citations', () => {
    const cited = 'https://x.com/nvidia/status/1234567890'
    const result = parseXCatalystResponse(response([
      { symbol: 'NVDA', kind: 'product-event', title: 'NVIDIA product event', description: 'NVIDIA scheduled a product event focused on its next accelerator platform.', date: '2026-09-01', timing: 'intraday', confidence: 'confirmed', sourceUrl: cited },
      { symbol: 'AAPL', kind: 'product-event', title: 'Not watched', description: 'Apple scheduled a product event.', date: '2026-09-02', timing: 'unknown', confidence: 'estimated', sourceUrl: cited },
      { symbol: 'NVDA', kind: 'conference', title: 'Invented URL', description: 'NVIDIA will appear at a conference.', date: '2026-09-03', timing: 'unknown', confidence: 'estimated', sourceUrl: 'https://x.com/example/status/999' },
    ], [cited]), ['NVDA'], NOW)

    expect(result.catalysts).toMatchObject([{
      id: 'xai-x-search:NVDA:product-event:2026-09-01',
      symbol: 'NVDA', description: 'NVIDIA scheduled a product event focused on its next accelerator platform.',
      source: 'Grok 4.6 X research', sourceUrl: cited,
    }])
    expect(result.rejected).toBe(2)
  })

  it('rejects a catalyst dated past the 180-day horizon', () => {
    const cited = 'https://x.com/nvidia/status/1234567890'
    // NOW is 2026-08-13, so the horizon falls on 2027-02-09.
    const result = parseXCatalystResponse(response([
      { symbol: 'NVDA', kind: 'product-event', title: 'Inside horizon', description: 'NVIDIA scheduled a product event inside the accepted window.', date: '2027-02-01', timing: 'unknown', confidence: 'estimated', sourceUrl: cited },
      { symbol: 'NVDA', kind: 'product-event', title: 'Beyond horizon', description: 'NVIDIA scheduled a product event beyond the accepted window.', date: '2027-06-01', timing: 'unknown', confidence: 'estimated', sourceUrl: cited },
    ], [cited]), ['NVDA'], NOW)

    expect(result.catalysts).toHaveLength(1)
    expect(result.catalysts[0]?.date).toBe('2027-02-01')
    expect(result.rejected).toBe(1)
  })

  it('rejects earnings because tastytrade owns that catalyst source', () => {
    const cited = 'https://x.com/nvidia/status/1234567890'
    expect(() => parseXCatalystResponse(response([
      { symbol: 'NVDA', kind: 'earnings', title: 'NVDA earnings', description: 'NVIDIA will report earnings.', date: '2026-09-01', timing: 'after-hours', confidence: 'confirmed', sourceUrl: cited },
    ], [cited]), ['NVDA'], NOW)).toThrow()
  })

  it('canonicalizes only direct X status URLs', () => {
    expect(canonicalXPostUrl('https://twitter.com/nvidia/status/123?ref=home')).toBe('https://x.com/nvidia/status/123')
    expect(canonicalXPostUrl('https://x.com/nvidia')).toBeUndefined()
  })

  it('researches the private watchlist only and excludes public lists', () => {
    expect(catalystResearchSymbols([
      { kind: 'private', symbols: ['AAPL', 'NVDA', 'AAPL'] },
      { kind: 'public', symbols: ['TSLA'] },
    ])).toEqual(['AAPL', 'NVDA'])
  })
})
