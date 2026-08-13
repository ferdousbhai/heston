import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'

import { type Ticker, type Watchlist } from '../domain/market'

const WATCHLIST_GROUPS = ['positions', 'private', 'public'] as const

export function TickerPicker({
  onClose,
  onPick,
  tickers,
  watchlists,
}: {
  onClose: () => void
  onPick: (watchlist: Watchlist, symbol: string) => void
  tickers: Ticker[]
  watchlists: Watchlist[]
}) {
  const [query, setQuery] = useState('')
  const dialogRef = useRef<HTMLElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const labels = { private: 'Private watchlists', positions: 'Open positions', public: 'Tastytrade public lists' }
  const tickerBySymbol = useMemo(() => new Map(tickers.map((ticker) => [ticker.symbol, ticker])), [tickers])
  const visibleWatchlists = useMemo(() => WATCHLIST_GROUPS.flatMap((kind) => watchlists
    .filter((watchlist) => watchlist.kind === kind)
    .map((watchlist) => ({
      ...watchlist,
      symbols: watchlist.symbols.filter((symbol) => {
        const ticker = tickerBySymbol.get(symbol)
        return Boolean(ticker && (!query || symbol.includes(query) || ticker.name.toUpperCase().includes(query)))
      }),
    }))
    .filter((watchlist) => watchlist.symbols.length)), [query, tickerBySymbol, watchlists])

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    searchRef.current?.focus()
    const keyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [])].filter((element) => !element.hidden)
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (!first || !last) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', keyDown)
    return () => {
      document.removeEventListener('keydown', keyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [onClose])

  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className="ticker-sheet" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="picker-title">
        <div className="sheet-handle" aria-hidden="true" />
        <header className="sheet-header">
          <h2 id="picker-title">Choose a ticker</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close ticker picker" type="button"><X size={20} /></button>
        </header>
        <label className="search-box">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Search tickers</span>
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value.toUpperCase())} placeholder="Search symbol or company" />
        </label>
        <div className="sheet-groups">
          {WATCHLIST_GROUPS.map((kind) => {
            const lists = visibleWatchlists.filter((watchlist) => watchlist.kind === kind)
            if (!lists.length) return null
            return (
              <div className="sheet-group" key={kind}>
                <h3>{labels[kind]}</h3>
                {lists.map((watchlist) => {
                  return (
                    <div className="picker-list" key={watchlist.id}>
                      <span className="picker-list-name">{watchlist.name}</span>
                      <div className="picker-symbols">
                        {watchlist.symbols.map((symbol) => (
                          <button key={symbol} onClick={() => onPick(watchlist, symbol)} type="button">
                            <strong>{symbol}</strong>
                            <span>{tickerBySymbol.get(symbol)!.name}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
          {!visibleWatchlists.length && <p className="picker-empty">No loaded tickers match.</p>}
        </div>
      </section>
    </div>
  )
}
