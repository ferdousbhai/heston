import { describe, expect, it, vi } from 'vitest'

import { JsonObjectSchema } from '../src/domain/json-payload'
import { collectOnlineResearch, runGrokResearchEditor } from '../src/server/research-online'
import { dailyResearchResponseSchema } from '../src/server/research-output'
import { unsupportedAi } from './fake-ai'

const NOW = new Date('2026-08-28T13:30:00.000Z')

describe('adaptive online research boundary', () => {
  it('keeps only watched findings backed by provider-returned citations', async () => {
    const cited = 'https://example.com/nvda-supply'
    const invented = 'https://example.com/invented'
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe('https://gateway.example/spice/grok/v1/responses')
      const request = JsonObjectSchema.parse(JSON.parse(String(init?.body)))
      expect(request.tools).toEqual([
        { type: 'web_search' },
        { type: 'x_search', from_date: '2026-08-14', to_date: '2026-08-29' },
      ])
      expect(request.tool_choice).toBe('required')
      expect(request).not.toHaveProperty('text')
      return Response.json({
        output: [{ type: 'message', content: [{
          type: 'output_text',
          text: `\`\`\`json\n${JSON.stringify({ findings: [{
            symbol: 'NVDA', title: 'NVIDIA signs a supply agreement',
            context: 'A signed supply agreement may improve near-term demand visibility; execution remains the key uncertainty.',
            sourceLabel: 'Example Wire', sourceUrl: cited,
          }, {
            symbol: 'NVDA', title: 'Invented source', context: 'This URL came only from prose.',
            sourceLabel: 'Unknown', sourceUrl: invented,
          }, {
            symbol: 'AAPL', title: 'Not in scope', context: 'This symbol was not requested.',
            sourceLabel: 'Example Wire', sourceUrl: cited,
          }] })}\n\`\`\``,
          annotations: [{ type: 'url_citation', url: cited }],
        }] }],
        usage: { server_side_tool_usage_details: { web_search_calls: 2, x_search_calls: 1 } },
      })
    })
    const secret = (value: string): SecretsStoreSecret => ({ get: async () => value })
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      const evidence = await collectOnlineResearch({
        AI: {
          ...unsupportedAi(),
          // SAFETY: this test path calls only the documented getUrl method.
          gateway: () => ({ getUrl: async () => 'https://gateway.example/spice/grok' }) as AiGateway,
        },
        AI_GATEWAY_TOKEN: secret('gateway-token'),
        XAI_API_KEY: secret('xai-key'),
      }, ['NVDA'], [{ symbol: 'NVDA', ivRank: 42 }], NOW, 'parent-run', fetcher)

      expect(evidence).toEqual([{
        context: 'A signed supply agreement may improve near-term demand visibility; execution remains the key uncertainty.',
        source: 'Grok research · example.com',
        symbols: ['NVDA'],
        title: 'NVIDIA signs a supply agreement',
        url: cited,
      }])
      const logged = info.mock.calls.map((call) => JSON.parse(String(call[0])))
      expect(logged).toContainEqual(expect.objectContaining({
        event: 'OnlineResearchCompleted', accepted: 1, rejected: 2, webSearches: 2, xSearches: 1,
      }))
    } finally {
      info.mockRestore()
    }
  })

  it('uses Grok structured output for the final editor without enabling unbound tools', async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      const request = JsonObjectSchema.parse(JSON.parse(String(init?.body)))
      expect(request.model).toBe('grok-4.6')
      expect(request).not.toHaveProperty('tools')
      expect(request.text).toEqual({
        format: {
          name: 'spice_daily_intelligence',
          schema: dailyResearchResponseSchema(),
          strict: true,
          type: 'json_schema',
        },
      })
      return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }] })
    })
    const secret = (value: string): SecretsStoreSecret => ({ get: async () => value })

    await expect(runGrokResearchEditor({
      AI: {
        ...unsupportedAi(),
        // SAFETY: this test path calls only the documented getUrl method.
        gateway: () => ({ getUrl: async () => 'https://gateway.example/spice/grok' }) as AiGateway,
      },
      AI_GATEWAY_TOKEN: secret('gateway-token'),
      XAI_API_KEY: secret('xai-key'),
    }, 'system', 'user', dailyResearchResponseSchema(), '2026-08-28', 'parent-run', fetcher))
      .resolves.toEqual(expect.objectContaining({ output: expect.any(Array) }))
  })
})
