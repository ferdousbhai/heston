import { describe, expect, it } from 'vitest'

import { type DailyResearchSubmission } from '../src/server/research-agent'
import { bindBriefCitations } from '../src/server/research-citation-binding'

const PAGE = 'https://ir.example.com/events'

function idea(overrides: Partial<DailyResearchSubmission['ideas'][number]> = {}) {
  return {
    description: 'The company presents at its investor day.',
    direction: 'bullish' as const,
    evidence: [{ quote: 'investor day on September 24, 2026', sourceIndex: 0 }],
    headline: 'Investor day lands inside the window',
    play: null,
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

describe('brief citation binding', () => {
  it('keeps an idea that quotes a page this run read', () => {
    // Markdown emphasis splits the quoted phrase; only the words decide the match.
    const bound = bindBriefCitations([idea()], sources, retained)

    expect(bound.ideas).toHaveLength(1)
    expect(bound.rejected).toEqual([])
  })

  it('drops an idea citing a page nothing read', () => {
    const bound = bindBriefCitations([idea()], [{ sourceUrl: 'https://elsewhere.example/x' }], retained)

    expect(bound.ideas).toEqual([])
    expect(bound.rejected).toEqual(['SPCX: cites a page this run never read'])
  })

  it('drops an idea whose quote is absent from its own source', () => {
    const invented = idea({ evidence: [{ quote: 'investor day on October 2, 2026', sourceIndex: 0 }] })

    const bound = bindBriefCitations([invented], sources, retained)

    expect(bound.ideas).toEqual([])
    expect(bound.rejected).toEqual(['SPCX: quote absent from its source'])
  })

  it('drops an idea that cites nothing at all', () => {
    const bound = bindBriefCitations([idea({ sourceIndices: [] })], sources, retained)

    expect(bound.ideas).toEqual([])
    expect(bound.rejected).toEqual(['SPCX: cites a page this run never read'])
  })

  it('keeps the ideas that hold when a sibling fails', () => {
    const good = idea()
    const bad = idea({ evidence: [{ quote: 'a sentence never published', sourceIndex: 0 }], symbol: 'BE' })

    const bound = bindBriefCitations([good, bad], sources, retained)

    expect(bound.ideas).toEqual([good])
    expect(bound.rejected).toEqual(['BE: quote absent from its source'])
  })
})
