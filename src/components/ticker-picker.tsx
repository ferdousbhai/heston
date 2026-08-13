import { useState } from 'react'
import { Search, X } from 'lucide-react'

import { type Ticker, type Watchlist } from '../domain/market'

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
  const groups = ['private', 'positions', 'public'] as const
  const labels = { private: 'Private watchlists', positions: 'Open positions', public: 'Tastytrade public lists' }
  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose() }}>
      <section className="ticker-sheet" role="dialog" aria-modal="true" aria-labelledby="picker-title">
        <div className="sheet-handle" aria-hidden="true" />
        <header className="sheet-header">
          <h2 id="picker-title">Choose a ticker</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close ticker picker" type="button"><X size={20} /></button>
        </header>
        <label className="search-box">
          <Search size={18} aria-hidden="true" />
          <span className="sr-only">Search tickers</span>
          <input value={query} onChange={(event) => setQuery(event.target.value.toUpperCase())} placeholder="Search symbol or company" autoFocus />
        </label>
        <div className="sheet-groups">
          {groups.map((kind) => {
            const lists = watchlists.filter((watchlist) => watchlist.kind === kind)
            if (!lists.length) return null
            return (
              <div className="sheet-group" key={kind}>
                <h3>{labels[kind]}</h3>
                {lists.map((watchlist) => {
                  const symbols = watchlist.symbols.filter((symbol) => {
                    const ticker = tickers.find((item) => item.symbol === symbol)
                    return !query || symbol.includes(query) || ticker?.name.toUpperCase().includes(query)
                  })
                  if (!symbols.length) return null
                  return (
                    <div className="picker-list" key={watchlist.id}>
                      <span className="picker-list-name">{watchlist.name}</span>
                      <div className="picker-symbols">
                        {symbols.map((symbol) => (
                          <button key={symbol} onClick={() => onPick(watchlist, symbol)} type="button">
                            <strong>{symbol}</strong>
                            <span>{tickers.find((ticker) => ticker.symbol === symbol)?.name ?? symbol}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </section>
    </div>
  )
}
