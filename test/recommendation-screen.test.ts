import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { RecommendationScreen, researchRunCountdown } from '../src/components/recommendation-screen'
import { marketSnapshotFixture } from './fixtures/market'

describe('recommendation availability', () => {
  it('replaces an empty generated recommendation with the next run and a soft countdown', () => {
    const latest = marketSnapshotFixture().recommendations!
    const dailyRecommendations = {
      ...latest,
      recommendations: [],
      links: [],
      regime: 'Weekend event screen',
      regimeDetail: 'Aug 29 2026 weekend; next session Aug 31.',
      summary: 'Investigating weekend catalysts before ranking.',
    }
    const html = renderToStaticMarkup(createElement(RecommendationScreen, {
      availableSymbols: new Set<string>(),
      dailyRecommendations: dailyRecommendations,
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
    const dailyRecommendations = marketSnapshotFixture().recommendations!
    const html = renderToStaticMarkup(createElement(RecommendationScreen, {
      availableSymbols: new Set(['NVDA']),
      dailyRecommendations: dailyRecommendations,
      now: new Date('2026-08-29T12:00:00.000Z'),
      onSymbol: () => undefined,
    }))

    expect(html).toContain('Selective long vol')
    expect(html).toContain('Demand checks keep the AI capex case alive')
    expect(html).toContain('Not financial advice.')
    expect(html).not.toContain('Every contract is illustrative')
    expect(html).not.toContain('Next research run')
  })

  it('renders reader links with title, description, and an optional preview image', () => {
    const dailyRecommendations = {
      ...marketSnapshotFixture().recommendations!,
      links: [{
        description: 'The primary announcement and its dated terms.',
        previewImageUrl: 'https://images.example.com/announcement.jpg',
        title: 'Primary announcement',
        url: 'https://example.com/announcement',
      }],
    }
    const html = renderToStaticMarkup(createElement(RecommendationScreen, {
      availableSymbols: new Set(['NVDA']),
      dailyRecommendations,
      onSymbol: () => undefined,
    }))

    // The list names itself; the heading stays for heading navigation but is not drawn.
    expect(html).toMatch(/<h2[^>]*sr-only[^>]*>Links<\/h2>/)
    expect(html).toContain('Primary announcement')
    expect(html).toContain('The primary announcement and its dated terms.')
    expect(html).toContain('src="https://images.example.com/announcement.jpg"')
    expect(html).toContain('referrerPolicy="no-referrer"')
  })

  it('reduces countdown precision as the run gets farther away', () => {
    const run = new Date('2026-08-31T13:30:00.000Z')
    expect(researchRunCountdown(new Date('2026-08-31T13:29:30.000Z'), run)).toBe('In about 1 minute')
    expect(researchRunCountdown(new Date('2026-08-31T09:00:00.000Z'), run)).toBe('In about 5 hours')
    expect(researchRunCountdown(new Date('2026-08-29T12:00:00.000Z'), run)).toBe('In about 2 days')
  })
})
