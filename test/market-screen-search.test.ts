// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MarketScreen } from '../src/components/market-screen'
import { marketSnapshotFixture } from './fixtures/market'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderMarket(): void {
  const snapshot = marketSnapshotFixture()
  render(createElement(MarketScreen, {
    activeWatchlist: { ...snapshot.watchlists[0]!, kind: 'public' as const },
    catalysts: snapshot.catalysts,
    owner: false,
    onSelectTicker: () => undefined,
    onTogglePinned: () => undefined,
    pinnedSymbols: [],
    dailyRecommendations: snapshot.recommendations,
    selected: snapshot.tickers[0]!,
    tickers: snapshot.tickers,
  }))
}

describe('searching beyond the loaded watchlist', () => {
  it('renders the symbol the catalog resolved, with the pin the reader can favorite it by', async () => {
    const lookupRequests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      // Reviewing a symbol with an empty month also asks for a catalyst search; this test
      // is about the symbol lookup, so only those requests are collected.
      if (url.startsWith('/api/public-catalyst-refresh')) {
        return Response.json({ catalysts: [], ran: false })
      }
      if (url.startsWith('/api/public-catalysts')) return Response.json({ catalysts: [] })
      if (url.startsWith('/api/public-year-candles')) return Response.json({ series: [] })
      // The focus card asks for the selected symbol's evidence cards for the same reason.
      if (url.startsWith('/api/public-symbol-evidence')) return Response.json({ evidence: [] })
      lookupRequests.push(url)
      return Response.json({
        catalysts: [],
        ticker: {
          symbol: 'TQQQ',
          name: 'ProShares UltraPro QQQ',
          assetType: 'etf',
          price: 92.4,
          change: 1.2,
          changePercent: 1.32,
          sparkline: [],
          ivRank: 41,
          ivPercentile: 47,
          ivIndex: 52.6,
          earningsDate: null,
          updatedAt: '2026-09-01T13:31:00.000Z',
        },
        watchlisted: true,
      })
    }))
    renderMarket()

    fireEvent.change(screen.getByLabelText('Search all symbols'), { target: { value: 'TQQQ' } })

    await waitFor(() => expect(screen.getByRole('button', { name: /TQQQ, ProShares UltraPro QQQ/ })).toBeTruthy())
    expect(lookupRequests).toEqual(['/api/public-symbol-search?q=TQQQ'])
    expect(screen.getByRole('button', { name: 'Pin TQQQ' })).toBeTruthy()
    // The lookup only runs for a search the loaded list could not answer.
    fireEvent.change(screen.getByLabelText('Search all symbols'), { target: { value: 'NVDA' } })
    await waitFor(() => expect(screen.queryByRole('button', { name: /TQQQ/ })).toBeNull())
    expect(lookupRequests).toHaveLength(1)
  })

  it('says the market has no such symbol rather than that the list does not', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (
      String(input).startsWith('/api/public-catalyst-refresh')
        ? Response.json({ catalysts: [], ran: false })
        : Response.json({ error: 'nothing' }, { status: 404 })
    )))
    renderMarket()

    fireEvent.change(screen.getByLabelText('Search all symbols'), { target: { value: 'ZZZZ' } })

    await waitFor(() => expect(screen.getByText('No listed symbol matches your search.')).toBeTruthy())
  })
})
