// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { addDays } from '../src/domain/iso-date'
import { marketDate, type Catalyst } from '../src/domain/catalyst'
import { renderMarketScreen } from './fixtures/render-market-screen'

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
  renderMarketScreen({ symbol, catalysts: [...catalysts], owner })
}

describe('reviewing a symbol with an empty calendar', () => {
  it('searches, says so, and shows what the search found', async () => {
    const requested: string[] = []
    const found = catalyst('AAPL', 45)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/public-catalysts') || url.startsWith('/api/public-year-candles')
        || url.startsWith('/api/public-symbol-evidence')) {
        return Response.json({ catalysts: [], evidence: [], series: [] })
      }
      requested.push(String(JSON.parse(String(init?.body)).symbol))
      return Response.json({ catalysts: [found], ran: true })
    }))

    renderMarket('AAPL', [])

    expect(screen.getByText(/Heston is searching for scheduled/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText('AAPL analyst day')).toBeTruthy())
    expect(requested).toEqual(['AAPL'])
    // The found date is on the calendar now, not a promise of the next snapshot.
    expect(screen.queryByText(/Heston is searching for scheduled/)).toBeNull()
  })

  it('leaves a symbol alone when something is already scheduled this month', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input))
      return Response.json({ catalysts: [], ran: false })
    }))

    renderMarket('TSLA', [catalyst('TSLA', 5)])

    await waitFor(() => expect(screen.getByText('TSLA analyst day')).toBeTruthy())
    // The focus card also asks for the symbol's evidence cards; what must not have been spent
    // here is a catalyst search, which a scheduled date this month makes unnecessary.
    expect(requested.filter((url) => url.startsWith('/api/public-catalyst-refresh'))).toEqual([])
  })

  it('keeps the empty calendar honest when the search finds nothing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ catalysts: [], ran: true })))

    renderMarket('META', [])

    await waitFor(() => expect(screen.getByText(/none are scheduled/)).toBeTruthy())
  })

  it('says a search that never answered did not finish, rather than that nothing is scheduled', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/public-catalyst-refresh')
      ? Response.json({ catalysts: [], ran: false, reason: 'failed' })
      : Response.json({ catalysts: [], evidence: [], series: [] })))

    renderMarket('NVDA', [])

    expect(await screen.findByText('The calendar search didn’t finish.')).toBeTruthy()
    expect(screen.queryByText(/none are scheduled/)).toBeNull()
  })

  it('treats a refresh request that errors as a failed search too', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/public-catalyst-refresh')
      ? new Response('', { status: 503 })
      : Response.json({ catalysts: [], evidence: [], series: [] })))

    renderMarket('AMD', [catalyst('AMD', 70)])

    expect(await screen.findByText(/dates didn’t finish/)).toBeTruthy()
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
