import { describe, expect, it } from 'vitest'

import { type DailyRecommendationsSubmission } from '../src/server/research-agent'
import { bindRecommendationCitations } from '../src/server/research-citation-binding'

const PAGE = 'https://ir.example.com/events'

function recommendation(overrides: Partial<DailyRecommendationsSubmission['recommendations'][number]> = {}) {
  return {
    description: 'The company presents at its investor day.',
    direction: 'bullish' as const,
    evidence: [{ quote: 'investor day on September 24, 2026', sourceIndex: 0 }],
    headline: 'Investor day lands inside the window',
    recommendedOrder: {
      kind: 'equity-option' as const,
      legs: [{
        action: 'Buy to Open' as const,
        contract: { expiry: '2026-10-16', optionType: 'C' as const, strike: 225, underlying: 'SPCX' },
        instrumentType: 'Equity Option' as const,
      }],
    },
    risk: 'The date slips.',
    sourceIndices: [0],
    symbol: 'SPCX',
    ...overrides,
  }
}

const sources = [{ sourceUrl: PAGE }]
const retained = new Map([[PAGE, {
  markdown: '## Events\n\nThe **investor day** on September 24, 2026 will be webcast.',
  readAt: '2026-08-31T12:00:00.000Z',
}]])

describe('recommendation citation binding', () => {
  it('keeps an recommendation that quotes a page this run read', () => {
    // Markdown emphasis splits the quoted phrase; only the words decide the match.
    const bound = bindRecommendationCitations([recommendation()], sources, retained)

    expect(bound.recommendations).toHaveLength(1)
    expect(bound.rejected).toEqual([])
  })

  it('drops an recommendation citing a page nothing read', () => {
    const bound = bindRecommendationCitations([recommendation()], [{ sourceUrl: 'https://elsewhere.example/x' }], retained)

    expect(bound.recommendations).toEqual([])
    expect(bound.rejected).toEqual(['SPCX: cites a page this run never read'])
  })

  it('drops an recommendation whose quote is absent from its own source', () => {
    const invented = recommendation({ evidence: [{ quote: 'investor day on October 2, 2026', sourceIndex: 0 }] })

    const bound = bindRecommendationCitations([invented], sources, retained)

    expect(bound.recommendations).toEqual([])
    expect(bound.rejected).toEqual(['SPCX: quote absent from its source'])
  })

  it('drops an recommendation that cites nothing at all', () => {
    // The submission schema requires at least one citation, so this cannot arrive from the
    // provider; the boundary refuses it on its own terms rather than trusting that.
    const bound = bindRecommendationCitations([recommendation({ sourceIndices: [] })], sources, retained)

    expect(bound.recommendations).toEqual([])
    expect(bound.rejected).toEqual(['SPCX: quotes a source it does not cite'])
  })

  it('drops an recommendation citing a source index past the end of the table', () => {
    // This one used to pass: mapping the index gives undefined, and a find that matches
    // undefined returns undefined too, which read as "nothing failed". The recommendation then threw
    // downstream and took the whole recommendation output with it.
    const bound = bindRecommendationCitations([recommendation({ sourceIndices: [7] })], sources, retained)

    expect(bound.recommendations).toEqual([])
    expect(bound.rejected).toEqual(['SPCX: cites a page this run never read'])
  })

  it('drops an recommendation quoting a page it never cited', () => {
    const strayQuote = recommendation({ evidence: [{ quote: 'investor day', sourceIndex: 3 }] })

    const bound = bindRecommendationCitations([strayQuote], sources, retained)

    expect(bound.recommendations).toEqual([])
    expect(bound.rejected).toEqual(['SPCX: quotes a source it does not cite'])
  })

  it('matches a citation and a retained page written the same way', () => {
    // read_page retains under a normalized URL; a citation of the bare origin is the same page.
    const bareOrigin = 'https://ir.example.com'
    const bound = bindRecommendationCitations(
      [recommendation({ evidence: [{ quote: 'investor day', sourceIndex: 0 }] })],
      [{ sourceUrl: bareOrigin }],
      new Map([[bareOrigin, { markdown: 'the investor day is webcast', readAt: '2026-08-31T12:00:00.000Z' }]]),
    )

    expect(bound.recommendations).toHaveLength(1)
  })

  it('keeps the recommendations that hold when a sibling fails', () => {
    const good = recommendation()
    const bad = recommendation({ evidence: [{ quote: 'a sentence never published', sourceIndex: 0 }], symbol: 'BE' })

    const bound = bindRecommendationCitations([good, bad], sources, retained)

    expect(bound.recommendations).toEqual([good])
    expect(bound.rejected).toEqual(['BE: quote absent from its source'])
  })
})
