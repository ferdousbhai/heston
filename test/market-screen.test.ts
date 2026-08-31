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
    research?: MarketSnapshot['research']
    symbol: string
  },
): string {
  return renderToStaticMarkup(createElement(MarketScreen, {
    activeWatchlist: { ...snapshot.watchlists[0]!, kind: 'public' },
    catalysts: overrides.catalysts ?? snapshot.catalysts,
    onManageWatchlist: () => undefined,
    onSelectTicker: () => undefined,
    onTogglePinned: () => undefined,
    pinnedSymbols: [],
    research: overrides.research ?? snapshot.research,
    selected: snapshot.tickers.find((ticker) => ticker.symbol === overrides.symbol)!,
    tickers: snapshot.tickers,
  }))
}

describe('selected market context', () => {
  it('leads with the selected symbol thesis and its dated catalysts', () => {
    const snapshot = marketSnapshotFixture()
    const research = {
      ...snapshot.research!,
      ideas: [
        snapshot.research!.ideas[0]!,
        {
          ...snapshot.research!.ideas[0]!,
          symbol: 'META' as const,
          headline: 'Unrelated META thesis',
          play: 'META 800c 10/16' as const,
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

    const html = renderMarket(snapshot, { catalysts, research, symbol: 'NVDA' })

    expect(html).toContain('Selected-symbol catalyst detail.')
    expect(html).toContain('Demand checks keep the AI capex thesis alive')
    expect(html).toContain('A guide-down or capex pause would break the demand thesis.')
    expect(html).toContain('NVDA 205c 10/16')
    expect(html).not.toContain('Unrelated META catalyst')
    expect(html).not.toContain('Unrelated META thesis')
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
    expect(html).toContain('2 dated')
  })

  it('states that nothing is scheduled instead of leaving a gap', () => {
    const snapshot = marketSnapshotFixture()

    const html = renderMarket(snapshot, {
      catalysts: [],
      research: { ...snapshot.research!, ideas: [] },
      symbol: 'SPY',
    })

    expect(html).toContain('Nothing dated')
    expect(html).toContain('Nothing is on the calendar.')
    expect(html).toContain('Spice tracks earnings, regulatory, clinical, investor day, product launch, conference and shareholder vote dates for SPY')
    expect(html).not.toContain('Thesis')
  })
})

describe('watchlist market data', () => {
  it('orders the core market columns and keeps lendability separate from a precise borrow rate', () => {
    const snapshot = marketSnapshotFixture()
    const nvda = snapshot.tickers.find((ticker) => ticker.symbol === 'NVDA')!
    nvda.borrowRate = 0.0375

    const html = renderMarket(snapshot, { symbol: 'NVDA' })
    const header = html.match(/<thead[^>]*>(.*?)<\/thead>/s)?.[1]

    expect(header).toMatch(/Market cap.*Price.*Volume/)
    expect(html).toContain('price-range')
    expect(html).toContain('Easy To Borrow')
    expect(html).toContain('0.0375% borrow')
  })

  it('distinguishes an exact provider zero from a rounded small borrow rate', () => {
    const snapshot = marketSnapshotFixture()
    const nvda = snapshot.tickers.find((ticker) => ticker.symbol === 'NVDA')!
    nvda.borrowRate = 0

    const html = renderMarket(snapshot, { symbol: 'NVDA' })

    expect(html).toContain('Reported 0%')
    expect(html).not.toContain('0.0000%')
  })
})
