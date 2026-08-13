import { describe, expect, it } from 'vitest'

import { canonicalXPostUrl, parseXCatalystResponse, shouldRunXCatalystResearch } from '../src/server/x-catalysts'

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
  it('accepts only future watched catalysts backed by returned X citations', () => {
    const cited = 'https://x.com/nvidia/status/1234567890'
    const result = parseXCatalystResponse(response([
      { symbol: 'NVDA', kind: 'product-event', title: 'NVIDIA product event', date: '2026-09-01', timing: 'intraday', confidence: 'confirmed', sourceUrl: cited },
      { symbol: 'AAPL', kind: 'product-event', title: 'Not watched', date: '2026-09-02', timing: 'unknown', confidence: 'estimated', sourceUrl: cited },
      { symbol: 'NVDA', kind: 'conference', title: 'Invented URL', date: '2026-09-03', timing: 'unknown', confidence: 'estimated', sourceUrl: 'https://x.com/example/status/999' },
    ], [cited]), ['NVDA'], NOW)

    expect(result.catalysts).toMatchObject([{
      id: 'xai-x-search:NVDA:product-event:2026-09-01',
      symbol: 'NVDA', source: 'Grok 4.6 X research', sourceUrl: cited,
    }])
    expect(result.rejected).toBe(2)
  })

  it('canonicalizes only direct X status URLs and schedules at 18:30 New York', () => {
    expect(canonicalXPostUrl('https://twitter.com/nvidia/status/123?ref=home')).toBe('https://x.com/nvidia/status/123')
    expect(canonicalXPostUrl('https://x.com/nvidia')).toBeUndefined()
    expect(shouldRunXCatalystResearch(NOW)).toBe(true)
  })
})
