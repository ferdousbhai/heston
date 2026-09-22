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

/** A viewport that answers only the phone breakpoint, the way a 400px window does. */
function stubPhoneViewport(): void {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    addEventListener: () => undefined,
    matches: query.startsWith('(max-width'),
    removeEventListener: () => undefined,
  })))
}

function renderMarket(onSelectTicker: (symbol: string) => void = () => undefined): void {
  const snapshot = marketSnapshotFixture()
  render(createElement(MarketScreen, {
    activeWatchlist: { ...snapshot.watchlists[0]!, kind: 'public' as const },
    catalysts: snapshot.catalysts,
    owner: false,
    onSelectTicker,
    onTogglePinned: () => undefined,
    pinnedSymbols: [],
    selected: snapshot.tickers.find((ticker) => ticker.symbol === 'NVDA')!,
    tickers: snapshot.tickers,
  }))
}

describe('the phone list', () => {
  it('replaces the table below the breakpoint and keeps the price in every row', () => {
    stubPhoneViewport()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ catalysts: [], ran: false })))

    renderMarket()

    expect(document.querySelector('.premium-data-table')).toBeNull()
    const rows = document.querySelectorAll('.watch-list .watch-row')
    expect(rows.length).toBeGreaterThan(1)
    const nvda = [...rows].find((row) => row.textContent?.includes('NVDA'))!
    expect(nvda.querySelector('.watch-row-quote')?.textContent).toContain('$191.68')
    expect(nvda.querySelector('.watch-pill')?.textContent).toBe('+2.6%')
    expect(nvda.querySelector('.watch-pill')?.getAttribute('data-tone')).toBe('up')
    // The empty rail is not drawn on a phone; nothing is pinned here.
    expect(screen.queryByText('Pin a ticker to see its upcoming events.')).toBeNull()
  })

  it('cycles every pill together through the readings the table has columns for', () => {
    stubPhoneViewport()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ catalysts: [], ran: false })))

    renderMarket()

    const pill = (symbol: string) => [...document.querySelectorAll('.watch-row')]
      .find((row) => row.textContent?.includes(symbol))!
      .querySelector('.watch-pill')!
    fireEvent.click(pill('NVDA'))
    expect(pill('NVDA').textContent).toBe('Expensive 72')
    expect(pill('NVDA').getAttribute('data-tone')).toBe('rich')
    expect(pill('SPCX').textContent).toBe('Cheap 26')
    fireEvent.click(pill('SPCX'))
    expect(pill('NVDA').textContent).toBe('128.4M')
    fireEvent.click(pill('NVDA'))
    expect(pill('NVDA').textContent).toBe('$4.7T')
    fireEvent.click(pill('NVDA'))
    expect(pill('NVDA').textContent).toBe('+2.6%')
  })

  it('sorts from one control and reads the direction back', () => {
    stubPhoneViewport()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ catalysts: [], ran: false })))

    renderMarket()

    const symbols = () => [...document.querySelectorAll('.watch-row .ticker-table-button strong')]
      .map((node) => node.textContent)
    const sortBy = screen.getByLabelText('Sort by')
    fireEvent.change(sortBy, { target: { value: 'premium' } })
    expect(symbols().slice(0, 2)).toEqual(['TSLA', 'NVDA'])
    fireEvent.click(screen.getByRole('button', { name: 'Sort ascending' }))
    expect(symbols()[0]).toBe('SPY')
    expect(screen.getByRole('button', { name: 'Sort descending' })).toBeTruthy()
  })

  it('keeps the selected name in a strip and opens the card as a sheet on a tap', () => {
    stubPhoneViewport()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ catalysts: [], ran: false })))
    const selected: string[] = []

    renderMarket((symbol) => selected.push(symbol))

    // The list is the screen: the card is not in the document until asked for.
    expect(document.querySelector('.focus-strip-symbol')?.textContent).toBe('NVDA')
    expect(document.querySelector('.focus-strip-read')?.textContent).toContain('Expensive 72')
    expect(document.querySelector('.instrument-focus')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^TSLA, Tesla/ }))

    expect(selected).toEqual(['TSLA'])
    expect(document.querySelector('[data-slot="drawer-popup"] .instrument-focus')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Close detail' })).toBeTruthy()
  })
})

describe('the phone row chart', () => {
  it('draws the year when the feed carries no session candles', async () => {
    stubPhoneViewport()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/public-year-candles')) {
        return Response.json({ asOf: '2026-08-31', series: [{ closes: [100, 104, 99, 110], symbol: 'NVDA' }] })
      }
      return Response.json({ catalysts: [], ran: false })
    }))
    const snapshot = marketSnapshotFixture()
    for (const ticker of snapshot.tickers) ticker.sparkline = []

    render(createElement(MarketScreen, {
      activeWatchlist: { ...snapshot.watchlists[0]!, kind: 'public' as const },
      catalysts: snapshot.catalysts,
      owner: false,
      onSelectTicker: () => undefined,
      onTogglePinned: () => undefined,
      pinnedSymbols: [],
      selected: snapshot.tickers[0]!,
      tickers: snapshot.tickers,
    }))

    await waitFor(() => {
      expect(document.querySelector('.watch-row .year-sparkline')).not.toBeNull()
    })
    expect(document.querySelectorAll('.watch-row .year-sparkline')).toHaveLength(1)
    expect(document.querySelector('.watch-row .session-sparkline')).toBeNull()
  })
})
