import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Plus, Trash2, X } from 'lucide-react'

import { type Ticker, type Watchlist } from '../domain/market'
import { type AggregateWatchlistMutation } from '../domain/watchlist'

export function WatchlistEditor({
  onClose,
  onMutation,
  tickers,
  watchlist,
}: {
  onClose: () => void
  onMutation: (action: AggregateWatchlistMutation) => Promise<void>
  tickers: Ticker[]
  watchlist: Watchlist
}) {
  const [symbol, setSymbol] = useState('')
  const [pending, setPending] = useState<string>()
  const [error, setError] = useState<string>()
  const dialogRef = useRef<HTMLElement>(null)
  const symbolRef = useRef<HTMLInputElement>(null)
  const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]))
  const availableSymbols = tickers
    .map((ticker) => ticker.symbol)
    .filter((candidate) => !watchlist.symbols.includes(candidate))

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    symbolRef.current?.focus()
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
      const last = focusable.at(-1)
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

  const mutate = async (key: string, action: AggregateWatchlistMutation): Promise<boolean> => {
    setPending(key)
    setError(undefined)
    try {
      await onMutation(action)
      return true
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : 'The watchlist could not be updated')
      return false
    } finally {
      setPending(undefined)
    }
  }

  const add = (event: FormEvent) => {
    event.preventDefault()
    const nextSymbol = symbol.trim().toUpperCase()
    if (!/^[A-Z.]{1,8}$/.test(nextSymbol)) {
      setError('Enter a valid equity symbol')
      return
    }
    if (watchlist.symbols.includes(nextSymbol)) {
      setError(`${nextSymbol} is already in this watchlist`)
      return
    }
    void (async () => {
      const succeeded = await mutate('add', {
        kind: 'add_watchlist_symbols',
        symbols: [nextSymbol],
      })
      if (succeeded) setSymbol('')
    })()
  }

  const busy = Boolean(pending)
  return (
    <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !busy) onClose() }}>
      <section className="ticker-sheet watchlist-sheet" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="watchlist-editor-title">
        <div className="sheet-handle" aria-hidden="true" />
        <header className="sheet-header">
          <div>
            <h2 id="watchlist-editor-title">Manage watchlist</h2>
          </div>
          <button className="icon-button" disabled={busy} onClick={onClose} aria-label="Close watchlist editor" type="button"><X size={20} /></button>
        </header>

        <form className="watchlist-add-form" onSubmit={add}>
          <label htmlFor="watchlist-symbol">Add a symbol</label>
          <div>
            <input
              autoCapitalize="characters"
              id="watchlist-symbol"
              list="available-watchlist-symbols"
              maxLength={8}
              placeholder="e.g. META"
              ref={symbolRef}
              value={symbol}
              onChange={(event) => setSymbol(event.target.value.toUpperCase())}
            />
            <datalist id="available-watchlist-symbols">
              {availableSymbols.map((candidate) => <option key={candidate} value={candidate} />)}
            </datalist>
            <button aria-label="Add symbol" disabled={busy || !symbol.trim()} type="submit"><Plus size={18} /></button>
          </div>
        </form>

        {error && <p className="watchlist-error" role="alert">{error}</p>}

        <div className="watchlist-members">
          <div className="watchlist-members-heading">
            <h3>Items</h3>
            <span>{watchlist.symbols.length}</span>
          </div>
          {watchlist.symbols.map((member) => (
            <div className="watchlist-member" key={member}>
              <div><strong>{member}</strong><span>{tickerBySymbol.get(member)?.name ?? 'Equity'}</span></div>
              <button
                aria-label={`Remove ${member} from ${watchlist.name}`}
                disabled={busy}
                onClick={() => void mutate(`remove-${member}`, {
                  kind: 'remove_watchlist_symbols',
                  symbols: [member],
                })}
                type="button"
              >
                {pending === `remove-${member}` ? <span className="mini-spinner" /> : <Trash2 size={16} />}
              </button>
            </div>
          ))}
          {!watchlist.symbols.length && <p className="watchlist-empty">Add a symbol to start this watchlist.</p>}
        </div>
      </section>
    </div>
  )
}
