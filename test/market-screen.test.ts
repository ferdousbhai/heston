import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { MarketScreen } from '../src/components/market-screen'
import { type MarketSnapshot } from '../src/domain/market'
import { marketSnapshotFixture } from './fixtures/market'

function renderMarket(
  snapshot: ReturnType<typeof marketSnapshotFixture>,
  overrides: {
    catalysts?: MarketSnapshot['catalysts']
    dailyRecommendations?: MarketSnapshot['recommendations']
    symbol: string
  },
): string {
  return renderToStaticMarkup(createElement(MarketScreen, {
    activeWatchlist: { ...snapshot.watchlists[0]!, kind: 'public' },
    catalysts: overrides.catalysts ?? snapshot.catalysts,
    owner: false,
    onSelectTicker: () => undefined,
    onTogglePinned: () => undefined,
    pinnedSymbols: [],
    dailyRecommendations: overrides.dailyRecommendations ?? snapshot.recommendations,
    selected: snapshot.tickers.find((ticker) => ticker.symbol === overrides.symbol)!,
    tickers: snapshot.tickers,
  }))
}

describe('selected market context', () => {
  it('leads with the selected symbol recommendation and its dated catalysts', () => {
    const snapshot = marketSnapshotFixture()
    const dailyRecommendations = {
      ...snapshot.recommendations!,
      recommendations: [
        snapshot.recommendations!.recommendations[0]!,
        {
          ...snapshot.recommendations!.recommendations[0]!,
          symbol: 'META' as const,
          headline: 'Unrelated META recommendation',
          recommendedOrder: {
            kind: 'equity-option' as const,
            legs: [{
              action: 'Buy to Open' as const,
              contract: { expiry: '2026-10-16', optionType: 'C' as const, strike: 800, underlying: 'META' },
              instrumentType: 'Equity Option' as const,
            }],
          },
        },
      ],
    }
    const catalysts = [
      {
        ...snapshot.catalysts[0]!,
        date: '2099-01-01',
        description: 'Selected-symbol catalyst detail.',
      },
      {
        ...snapshot.catalysts[0]!,
        id: 'test:META:earnings',
        symbol: 'META' as const,
        title: 'Unrelated META catalyst',
      },
    ]

    const html = renderMarket(snapshot, { catalysts, dailyRecommendations, symbol: 'NVDA' })

    expect(html).toContain('Selected-symbol catalyst detail.')
    expect(html).toContain('Demand checks keep the AI capex case alive')
    expect(html).toContain('A guide-down or capex pause would break the demand case.')
    expect(html).toContain('Buy to Open NVDA 205C · 2026-10-16')
    expect(html).not.toContain('Unrelated META catalyst')
    expect(html).not.toContain('Unrelated META recommendation')
  })

  it('lists every upcoming catalyst nearest first and drops past dates', () => {
    const snapshot = marketSnapshotFixture()
    const template = snapshot.catalysts[0]!
    const catalysts = [
      { ...template, id: 'test:NVDA:later', date: '2099-06-01', kind: 'regulatory' as const, title: 'Later NVDA review' },
      { ...template, id: 'test:NVDA:past', date: '2000-01-01', title: 'Stale NVDA event' },
      { ...template, id: 'test:NVDA:sooner', date: '2099-01-01', title: 'Sooner NVDA print', confidence: 'confirmed' as const },
    ]

    const html = renderMarket(snapshot, { catalysts, symbol: 'NVDA' })

    expect(html).not.toContain('Stale NVDA event')
    expect(html.indexOf('Sooner NVDA print')).toBeLessThan(html.indexOf('Later NVDA review'))
  })

  it('states that nothing is scheduled instead of leaving a gap', () => {
    const snapshot = marketSnapshotFixture()

    const html = renderMarket(snapshot, {
      catalysts: [],
      dailyRecommendations: { ...snapshot.recommendations!, recommendations: [] },
      symbol: 'SPY',
    })

    expect(html).toContain('Nothing is on the calendar.')
    expect(html).toContain('Spice tracks earnings, regulatory, clinical, investor day, product launch, conference and shareholder vote dates for SPY')
    expect(html).not.toContain('Recommendation')
  })
})

describe('watchlist market data', () => {
  it('orders the core market columns and reports lending as lendability alone', () => {
    const snapshot = marketSnapshotFixture()

    const html = renderMarket(snapshot, { symbol: 'NVDA' })
    const header = html.match(/<thead[^>]*>(.*?)<\/thead>/s)?.[1]

    expect(header).toMatch(/Market cap.*Price.*Volume/)
    expect(html).toContain('price-range')
    expect(html).toContain('Easy To Borrow')
    expect(html).not.toContain('borrow')
  })

  it('dates the quote and the metrics separately, and says when the metrics carry no date', () => {
    const snapshot = marketSnapshotFixture()
    const nvda = snapshot.tickers.find((ticker) => ticker.symbol === 'NVDA')!
    nvda.metricsUpdatedAt = '2026-08-13T05:00:00.000Z'

    const dated = renderMarket(snapshot, { symbol: 'NVDA' })
    const freshness = dated.match(/<p class="focus-freshness">(.*?)<\/p>/s)?.[1]
    expect(freshness).toContain('dateTime="2026-08-13T13:31:00.000Z"')
    expect(freshness).toContain('dateTime="2026-08-13T05:00:00.000Z"')
    expect(freshness).toMatch(/Quote <time[^>]*>\d+ days? ago<\/time>/)
    expect(freshness).toMatch(/IV &amp; liquidity <time[^>]*>\d+ days? ago<\/time>/)

    const undated = renderMarket(snapshot, { symbol: 'SPY' })
    expect(undated.match(/<p class="focus-freshness">(.*?)<\/p>/s)?.[1]).toContain('age not reported')
  })
})
