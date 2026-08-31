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
    // The submission schema requires at least one citation, so this cannot arrive from the
    // provider; the boundary refuses it on its own terms rather than trusting that.
    const bound = bindBriefCitations([idea({ sourceIndices: [] })], sources, retained)

    expect(bound.ideas).toEqual([])
    expect(bound.rejected).toEqual(['SPCX: quotes a source it does not cite'])
  })

  it('drops an idea citing a source index past the end of the table', () => {
    // This one used to pass: mapping the index gives undefined, and a find that matches
    // undefined returns undefined too, which read as "nothing failed". The idea then threw
    // downstream and took the whole brief with it.
    const bound = bindBriefCitations([idea({ sourceIndices: [7] })], sources, retained)

    expect(bound.ideas).toEqual([])
    expect(bound.rejected).toEqual(['SPCX: cites a page this run never read'])
  })

  it('drops an idea quoting a page it never cited', () => {
    const strayQuote = idea({ evidence: [{ quote: 'investor day', sourceIndex: 3 }] })

    const bound = bindBriefCitations([strayQuote], sources, retained)

    expect(bound.ideas).toEqual([])
    expect(bound.rejected).toEqual(['SPCX: quotes a source it does not cite'])
  })

  it('matches a citation and a retained page written the same way', () => {
    // read_page retains under a normalized URL; a citation of the bare origin is the same page.
    const bareOrigin = 'https://ir.example.com'
    const bound = bindBriefCitations(
      [idea({ evidence: [{ quote: 'investor day', sourceIndex: 0 }] })],
      [{ sourceUrl: bareOrigin }],
      new Map([[bareOrigin, { markdown: 'the investor day is webcast', readAt: '2026-08-31T12:00:00.000Z' }]]),
    )

    expect(bound.ideas).toHaveLength(1)
  })

  it('keeps the ideas that hold when a sibling fails', () => {
    const good = idea()
    const bad = idea({ evidence: [{ quote: 'a sentence never published', sourceIndex: 0 }], symbol: 'BE' })

    const bound = bindBriefCitations([good, bad], sources, retained)

    expect(bound.ideas).toEqual([good])
    expect(bound.rejected).toEqual(['BE: quote absent from its source'])
  })
})
