import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { MarketScreen } from '../src/components/market-screen'
import { marketSnapshotFixture } from './fixtures/market'

describe('selected market context', () => {
  it('shows only the selected symbol catalyst note and Daily Brief thesis', () => {
    const snapshot = marketSnapshotFixture()
    const selected = snapshot.tickers.find((ticker) => ticker.symbol === 'NVDA')!
    const research = {
      ...snapshot.research,
      ideas: [
        snapshot.research.ideas[0]!,
        {
          ...snapshot.research.ideas[0]!,
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

    const html = renderToStaticMarkup(createElement(MarketScreen, {
      activeWatchlist: { ...snapshot.watchlists[0]!, kind: 'public' },
      catalysts,
      onManageWatchlist: () => undefined,
      onSelectTicker: () => undefined,
      onTogglePinned: () => undefined,
      pinnedSymbols: [],
      research,
      selected,
      tickers: snapshot.tickers,
    }))

    expect(html).toContain('Selected-symbol catalyst detail.')
    expect(html).toContain('Demand checks keep the AI capex thesis alive')
    expect(html).toContain('A guide-down or capex pause would break the demand thesis.')
    expect(html).not.toContain('Unrelated META catalyst')
    expect(html).not.toContain('Unrelated META thesis')
  })

  it('states when the selected symbol has no stored context', () => {
    const snapshot = marketSnapshotFixture()
    const selected = snapshot.tickers.find((ticker) => ticker.symbol === 'SPY')!
    const html = renderToStaticMarkup(createElement(MarketScreen, {
      activeWatchlist: { ...snapshot.watchlists[0]!, kind: 'public' },
      catalysts: [],
      onManageWatchlist: () => undefined,
      onSelectTicker: () => undefined,
      onTogglePinned: () => undefined,
      pinnedSymbols: [],
      research: { ...snapshot.research, ideas: [] },
      selected,
      tickers: snapshot.tickers,
    }))

    expect(html).toContain('No upcoming catalyst or Daily Brief thesis is available for SPY.')
  })
})
