import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BriefScreen, researchRunCountdown } from '../src/components/brief-screen'
import { marketSnapshotFixture } from './fixtures/market'

describe('brief availability', () => {
  it('replaces an empty generated brief with the next run and a soft countdown', () => {
    const latest = marketSnapshotFixture().research!
    const brief = {
      ...latest,
      ideas: [],
      readingList: [],
      regime: 'Weekend event screen',
      regimeDetail: 'Aug 29 2026 weekend; next session Aug 31.',
      summary: 'Investigating weekend catalysts before ranking.',
    }
    const html = renderToStaticMarkup(createElement(BriefScreen, {
      availableSymbols: new Set<string>(),
      brief,
      now: new Date('2026-08-29T12:00:00.000Z'),
      onSymbol: () => undefined,
    }))

    expect(html).toContain('Next research run')
    expect(html).toContain('Monday, Aug 31 at 9:30 AM EDT')
    expect(html).toContain('In about 2 days')
    expect(html).toContain('Previous')
    expect(html).not.toContain('Weekend event screen')
    expect(html).not.toContain('Investigating weekend catalysts')
    expect(html).not.toContain('Research context only')
  })

  it('shows completed research unchanged', () => {
    const brief = marketSnapshotFixture().research!
    const html = renderToStaticMarkup(createElement(BriefScreen, {
      availableSymbols: new Set(['NVDA']),
      brief,
      now: new Date('2026-08-29T12:00:00.000Z'),
      onSymbol: () => undefined,
    }))

    expect(html).toContain('Selective long vol')
    expect(html).toContain('Demand checks keep the AI capex thesis alive')
    expect(html).toContain('Not financial advice.')
    expect(html).not.toContain('Every contract is illustrative')
    expect(html).not.toContain('Next research run')
  })

  it('reduces countdown precision as the run gets farther away', () => {
    const run = new Date('2026-08-31T13:30:00.000Z')
    expect(researchRunCountdown(new Date('2026-08-31T13:29:30.000Z'), run)).toBe('In about 1 minute')
    expect(researchRunCountdown(new Date('2026-08-31T09:00:00.000Z'), run)).toBe('In about 5 hours')
    expect(researchRunCountdown(new Date('2026-08-29T12:00:00.000Z'), run)).toBe('In about 2 days')
  })
})
