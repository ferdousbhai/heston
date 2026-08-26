// @vitest-environment jsdom

import { Fragment, createElement, useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TickerPicker } from '../src/components/ticker-picker'
import { marketTickersFixture, marketWatchlistsFixture } from './fixtures/market'

function TickerPickerHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false)
  return createElement(
    Fragment,
    null,
    createElement('button', { onClick: () => setOpen(true), type: 'button' }, 'Open picker'),
    open && createElement(TickerPicker, {
      onClose: () => {
        onClose()
        setOpen(false)
      },
      onPick: vi.fn(),
      tickers: marketTickersFixture,
      watchlists: marketWatchlistsFixture
        .filter((watchlist) => watchlist.kind === 'positions')
        .map((watchlist) => ({ ...watchlist, symbols: ['MISSING', ...watchlist.symbols] })),
    }),
  )
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
})

describe('TickerPicker accessibility', () => {
  it('autofocuses search, closes with Escape, and returns focus to the opener', async () => {
    const onClose = vi.fn()
    render(createElement(TickerPickerHarness, { onClose }))
    const opener = screen.getByRole('button', { name: 'Open picker' })
    opener.focus()
    fireEvent.click(opener)

    const dialog = screen.getByRole('dialog', { name: 'Choose a ticker' })
    expect(within(dialog).getByRole('button', { name: 'Close ticker picker' })).toBeTruthy()
    expect(within(dialog).queryByText('MISSING')).toBeNull()
    const search = screen.getByRole('combobox', { name: 'Search symbol or company' })
    expect(document.activeElement).toBe(search)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
})
