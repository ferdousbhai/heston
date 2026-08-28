import { describe, expect, it, vi } from 'vitest'
import { JsonObjectSchema } from '../src/domain/json-payload'

import { canonicalXPostUrl, catalystResearchSymbols, discoverXCatalysts, parseXCatalystResponse } from '../src/server/x-catalysts'
import { unsupportedAi } from './fake-ai'

const NOW = new Date('2026-08-13T22:30:00.000Z')

function response(findings: unknown[], citations: string[]) {
  return textResponse(JSON.stringify({ findings }), citations)
}

function textResponse(text: string, citations: string[]) {
  return {
    output: [{ type: 'message', content: [{
      type: 'output_text', text,
      annotations: citations.map((url) => ({ type: 'url_citation', url })),
    }] }],
  }
}

function searchedResponse(findings: unknown[], annotations: string[], toolResults: string[] = [], searches = 4) {
  const text = [
    'I searched X for each ticker. The strongest post was',
    'https://x.com/nvidia/status/1234567890, and the findings follow.',
    '',
    '```json',
    JSON.stringify({ findings }),
    '```',
  ].join('\n')
  return {
    output: [
      { type: 'custom_tool_call', name: 'x_semantic_search', call_id: 'xs_call_1', status: 'completed',
        results: toolResults.map((url) => ({ url, title: 'Post' })) },
      { type: 'message', content: [{
        type: 'output_text', text,
        annotations: annotations.map((url, index) => ({
          type: 'url_citation', url, start_index: 0, end_index: 1, title: String(index + 1),
        })),
      }] },
    ],
    usage: { server_side_tool_usage_details: { x_search_calls: searches } },
  }
}

const FINDING = {
  symbol: 'NVDA', kind: 'product-event', title: 'NVIDIA product event',
  description: 'NVIDIA scheduled a product event focused on its next accelerator platform.',
  date: '2026-09-01', timing: 'intraday', confidence: 'confirmed',
  sourceUrl: 'https://x.com/nvidia/status/1234567890',
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
      expect(request.tools).toEqual([{ type: 'x_search', from_date: '2026-02-14', to_date: '2026-08-14' }])
      expect(request.tool_choice).toBe('required')
      expect(request).not.toHaveProperty('text')
      expect(request).not.toHaveProperty('response_format')
      expect(request.include).toEqual(['no_inline_citations'])
      const prompt = JSON.stringify(request.input)
      expect(prompt).toContain('publication window, not the event window')
      expect(prompt).toContain('2027-02-09')
      expect(prompt).toContain('fenced ```json code block')
      expect(prompt).toContain('investor-event, product-event, regulatory, clinical, conference, shareholder')
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

  it('batches a wide required X sweep before the provider response can exceed its bound', async () => {
    const requestedBatches: string[][] = []
    const metadata: Array<Record<string, string>> = []
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JsonObjectSchema.parse(JSON.parse(String(init?.body)))
      const prompt = JSON.stringify(request.input)
      const symbols = prompt.match(/only these tickers: ([^.]+)\./)?.[1]?.split(', ') ?? []
      requestedBatches.push(symbols)
      metadata.push(JSON.parse(new Headers(init?.headers).get('cf-aig-metadata') ?? '{}'))
      return Response.json(searchedResponse([], [], [], 2))
    })
    const secret = (value: string): SecretsStoreSecret => ({ get: async () => value })
    const symbols = Array.from({ length: 17 }, (_, index) => `T${index}`)

    // SAFETY: discoverXCatalysts reaches only getUrl; every other fake AI method throws.
    await discoverXCatalysts({
      AI: {
        ...unsupportedAi(),
        gateway: () => ({ getUrl: async () => 'https://gateway.example/spice/grok' }) as AiGateway,
      },
      AI_GATEWAY_TOKEN: secret('gateway-token'),
      XAI_API_KEY: secret('xai-key'),
    }, symbols, NOW, fetcher, 'parent-run')

    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(requestedBatches.map((batch) => batch.length)).toEqual([8, 8, 1])
    expect(requestedBatches.flat()).toEqual(symbols)
    expect(metadata.map((item) => item.batch)).toEqual(['1/3', '2/3', '3/3'])
    expect(new Set(metadata.map((item) => item.run_id)).size).toBe(3)
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

  it('trusts the url_citation annotations a searched answer reports', () => {
    const result = parseXCatalystResponse(
      searchedResponse([FINDING], [FINDING.sourceUrl]),
      ['NVDA'],
      NOW,
    )

    expect(result.catalysts).toMatchObject([{ symbol: 'NVDA', sourceUrl: FINDING.sourceUrl }])
    expect(result.citations).toBe(1)
    expect(result.rejected).toBe(0)
  })

  it('trusts a source the X Search tool item reported', () => {
    const result = parseXCatalystResponse(
      searchedResponse([FINDING], [], [`${FINDING.sourceUrl}?s=20`]),
      ['NVDA'],
      NOW,
    )

    expect(result.catalysts).toMatchObject([{ sourceUrl: FINDING.sourceUrl }])
  })

  it('accepts the handle-less status URL form X Search cites', () => {
    const cited = 'https://x.com/i/status/1975607901571199086'
    const result = parseXCatalystResponse(
      searchedResponse([{ ...FINDING, sourceUrl: cited }], [cited]),
      ['NVDA'],
      NOW,
    )

    expect(result.catalysts).toMatchObject([{ sourceUrl: cited }])
  })

  it('never lets the model certify its own source URL', () => {
    const result = parseXCatalystResponse(searchedResponse([FINDING], []), ['NVDA'], NOW)

    expect(result.catalysts).toEqual([])
    expect(result.citations).toBe(0)
    expect(result.rejected).toBe(1)
  })

  it('reads the findings JSON out of the prose the model wrapped around it', () => {
    const cited = FINDING.sourceUrl
    const fenced = `Here is what I found on X.\n\n\`\`\`json\n${JSON.stringify({ findings: [FINDING] })}\n\`\`\`\n\nLet me know if you want more.`

    expect(parseXCatalystResponse(textResponse(fenced, [cited]), ['NVDA'], NOW).catalysts)
      .toMatchObject([{ symbol: 'NVDA', sourceUrl: cited }])
    expect(parseXCatalystResponse(
      textResponse(`Findings: ${JSON.stringify({ findings: [FINDING] })}`, [cited]),
      ['NVDA'],
      NOW,
    ).catalysts).toHaveLength(1)
  })

  it('fails loudly when the answer carries no usable findings JSON', () => {
    expect(() => parseXCatalystResponse(textResponse('I could not find any catalysts.', []), ['NVDA'], NOW))
      .toThrow(/unparsable-findings/)
    expect(() => parseXCatalystResponse(textResponse('```json\n{"findings": [ {,,, ]\n```', []), ['NVDA'], NOW))
      .toThrow(/unparsable-findings/)
    expect(() => parseXCatalystResponse(textResponse('```json\n{"catalysts": []}\n```', []), ['NVDA'], NOW))
      .toThrow()
  })

  it('strips inline citation markdown the model wrote into a finding', () => {
    const cited = 'https://x.com/nvidia/status/1234567890'
    const result = parseXCatalystResponse(searchedResponse([{
      ...FINDING,
      title: 'NVIDIA product event [[1]](https://x.com/nvidia/status/1234567890)',
      description: `NVIDIA scheduled a product event [[1]](${cited}) for its next accelerator platform.`,
      sourceUrl: cited,
    }], [cited]), ['NVDA'], NOW)

    expect(result.catalysts).toMatchObject([{
      title: 'NVIDIA product event',
      description: 'NVIDIA scheduled a product event for its next accelerator platform.',
    }])
  })

  it('keeps a finding whose citation markdown would have overrun the description bound', () => {
    const cited = 'https://x.com/nvidia/status/1234567890'
    const description = `${'NVIDIA scheduled a product event. '.repeat(14)}[[1]](${cited})`
    expect(description.length).toBeGreaterThan(500)

    const result = parseXCatalystResponse(
      searchedResponse([{ ...FINDING, description, sourceUrl: cited }], [cited]),
      ['NVDA'],
      NOW,
    )

    expect(result.catalysts).toHaveLength(1)
    expect(result.catalysts[0]?.description).not.toContain('[[1]]')
  })

  it('reports whether the provider actually ran an X search', () => {
    expect(parseXCatalystResponse(searchedResponse([], [], [], 7), ['NVDA'], NOW).searches).toBe(7)
    expect(parseXCatalystResponse(response([], []), ['NVDA'], NOW).searches).toBeUndefined()
  })

  it('rejects a catalyst dated past the 180-day horizon', () => {
    const cited = 'https://x.com/nvidia/status/1234567890'
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
