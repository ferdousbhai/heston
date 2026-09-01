// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MarketScreen } from '../src/components/market-screen'
import { addDays } from '../src/domain/iso-date'
import { marketDate, type Catalyst } from '../src/domain/catalyst'
import { marketSnapshotFixture } from './fixtures/market'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function catalyst(symbol: string, daysAhead: number): Catalyst {
  const date = addDays(marketDate(), daysAhead)
  return {
    confidence: 'estimated',
    date,
    id: `exa:${symbol}:conference:${date}`,
    kind: 'conference',
    source: 'Exa search · example.com',
    sourceUrl: 'https://example.com/events',
    symbol,
    timing: 'unknown',
    title: `${symbol} analyst day`,
    updatedAt: '2026-09-01T13:00:00.000Z',
  }
}

function renderMarket(symbol: string, catalysts: readonly Catalyst[], owner = false): void {
  const snapshot = marketSnapshotFixture()
  render(createElement(MarketScreen, {
    activeWatchlist: { ...snapshot.watchlists[0]!, kind: 'public' as const },
    catalysts: [...catalysts],
    owner,
    onSelectTicker: () => undefined,
    onTogglePinned: () => undefined,
    pinnedSymbols: [],
    dailyRecommendations: undefined,
    selected: snapshot.tickers.find((ticker) => ticker.symbol === symbol)!,
    tickers: snapshot.tickers,
  }))
}

describe('reviewing a symbol with an empty calendar', () => {
  it('searches, says so, and shows what the search found', async () => {
    const requested: string[] = []
    const found = catalyst('AAPL', 45)
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requested.push(String(JSON.parse(String(init.body)).symbol))
      return Response.json({ catalysts: [found], ran: true })
    }))

    renderMarket('AAPL', [])

    expect(screen.getByText(/Spice is searching for scheduled/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText('AAPL analyst day')).toBeTruthy())
    expect(requested).toEqual(['AAPL'])
    // The found date is on the calendar now, not a promise of the next snapshot.
    expect(screen.queryByText(/Spice is searching for scheduled/)).toBeNull()
  })

  it('leaves a symbol alone when something is already scheduled this month', async () => {
    const fetchMock = vi.fn(async () => Response.json({ catalysts: [], ran: false }))
    vi.stubGlobal('fetch', fetchMock)

    renderMarket('TSLA', [catalyst('TSLA', 5)])

    await waitFor(() => expect(screen.getByText('TSLA analyst day')).toBeTruthy())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps the empty calendar honest when the search finds nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ catalysts: [], ran: true })))

    renderMarket('META', [])

    await waitFor(() => expect(screen.getByText(/none are scheduled/)).toBeTruthy())
  })
})

describe('owner catalyst refresh', () => {
  it('offers the owner another search on a thin calendar, and never a visitor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ catalysts: [], ran: true })))

    renderMarket('BE', [])
    await screen.findByText('Nothing is on the calendar.')
    // A visitor cannot spend a search: the call costs money and the window that bounds
    // incidental attention is the only thing standing between it and every reader.
    expect(screen.queryByRole('button', { name: 'Search again' })).toBeNull()

    cleanup()
    renderMarket('BE', [], true)
    expect(await screen.findByRole('button', { name: 'Search again' })).toBeTruthy()
  })

  it('reports a search running on a calendar that already has a far-off date on it', async () => {
    // Nothing resolves while the search is in flight, which is the state a reader was left
    // staring at with no sign anything was happening.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))

    // Dated past the near-term window, so the runway renders a row and a search still runs.
    renderMarket('QQQ', [catalyst('QQQ', 70)], true)

    expect(await screen.findByText(/Searching for nearer/)).toBeTruthy()
    // The control that would spend a second search is not offered while one is running.
    expect(screen.queryByRole('button', { name: 'Search again' })).toBeNull()
  })
})
