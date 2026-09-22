// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { MarketScreen } from '../src/components/market-screen'
import { type SymbolEvidence } from '../src/domain/symbol-evidence'
import { marketSnapshotFixture } from './fixtures/market'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function card(overrides: Partial<SymbolEvidence> = {}): SymbolEvidence {
  return {
    byline: 'volwatcher',
    id: 'member-evidence:one',
    note: 'Visibility into next year, not this quarter.',
    quote: 'signed a multi-year supply agreement',
    recordedAt: '2026-09-02T13:45:00.000Z',
    sourceTitle: 'NVIDIA supply agreement',
    sourceUrl: 'https://www.reuters.com/technology/nvidia-supply',
    symbol: 'NVDA',
    ...overrides,
  }
}

/** Answers both requests the focus card makes: the catalyst search, and the evidence read. */
function stubFetch(evidence: readonly SymbolEvidence[]): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (
    String(input).startsWith('/api/public-symbol-evidence')
      ? Response.json({ evidence })
      : Response.json({ catalysts: [], ran: false })
  )))
}

function renderMarket(symbol: string): void {
  const snapshot = marketSnapshotFixture()
  render(createElement(MarketScreen, {
    activeWatchlist: { ...snapshot.watchlists[0]!, kind: 'public' as const },
    catalysts: snapshot.catalysts,
    owner: false,
    onSelectTicker: () => undefined,
    onTogglePinned: () => undefined,
    pinnedSymbols: [],
    selected: snapshot.tickers.find((ticker) => ticker.symbol === symbol)!,
    tickers: snapshot.tickers,
  }))
}

describe('evidence recorded under the selected symbol', () => {
  it('shows the quote, the recorder\'s reading of it, and the page it came from', async () => {
    stubFetch([card()])

    renderMarket('NVDA')

    expect(await screen.findByText('signed a multi-year supply agreement')).toBeTruthy()
    expect(screen.getByText('Visibility into next year, not this quarter.')).toBeTruthy()
    // The byline the member chose is the whole of the attribution a reader sees.
    expect(screen.getByText('volwatcher')).toBeTruthy()
    const source = screen.getByRole('link', { name: /reuters\.com/ })
    expect(source.getAttribute('href')).toBe('https://www.reuters.com/technology/nvidia-supply')
    expect(source.getAttribute('target')).toBe('_blank')
    expect(source.getAttribute('rel')).toBe('noreferrer')
  })

  it('says nothing at all when nothing has been recorded', async () => {
    stubFetch([])

    renderMarket('NVDA')

    await waitFor(() => expect(document.querySelector('.focus-runway')).not.toBeNull())
    expect(document.querySelector('.focus-evidence')).toBeNull()
  })
})
