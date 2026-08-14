// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TickerPicker } from '../src/components/ticker-picker'
import { marketTickersFixture, marketWatchlistsFixture } from './fixtures/market'

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('TickerPicker accessibility', () => {
  it('closes with Escape, traps focus, and returns focus to the opener', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const onClose = vi.fn()
    const { unmount } = render(createElement(TickerPicker, {
      onClose,
      onPick: vi.fn(),
      tickers: marketTickersFixture,
      watchlists: marketWatchlistsFixture
        .filter((watchlist) => watchlist.kind === 'positions')
        .map((watchlist) => ({ ...watchlist, symbols: ['MISSING', ...watchlist.symbols] })),
    }))

    const dialog = screen.getByRole('dialog', { name: 'Choose a ticker' })
    const close = within(dialog).getByRole('button', { name: 'Close ticker picker' })
    const buttons = within(dialog).getAllByRole('button')
    const last = buttons.at(-1)!
    expect(within(dialog).queryByText('MISSING')).toBeNull()
    expect(document.activeElement).toBe(screen.getByPlaceholderText('Search symbol or company'))

    close.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(close)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    unmount()
    expect(document.activeElement).toBe(opener)
  })
})
