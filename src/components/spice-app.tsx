import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { Bot, Newspaper, TrendingUp } from 'lucide-react'

import {
  applyWatchlistMutation,
  catalystCollection,
  isSnapshotInitialized,
  preferenceCollection,
  researchCollection,
  requestPersistentLocalStorage,
  restoreOfflineSnapshot,
  selectTicker,
  selectLiveMarketSymbols,
  selectWatchlist,
  syncFromCloud,
  syncStateCollection,
  tickerCollection,
  watchlistCollection,
} from '../data/collections'
import { type Watchlist } from '../domain/market'
import { type AggregateWatchlistMutation } from '../domain/watchlist'
import { useLiveMarket } from '../data/live-market'
import { AgentScreen } from './agent-screen'
import { AuthGate, type Viewer } from './auth-gate'
import { BriefScreen } from './brief-screen'
import { MarketScreen } from './market-screen'
import { TickerPicker } from './ticker-picker'
import { TopBar } from './top-bar'
import { WatchlistEditor } from './watchlist-editor'

type Tab = 'market' | 'brief' | 'agent'

export function SpiceApp() {
  return <AuthGate>{(viewer) => <AuthenticatedSpiceApp viewer={viewer} />}</AuthGate>
}

function AuthenticatedSpiceApp({ viewer }: { viewer: Viewer | null }) {
  const { data: storedTickers = [] } = useLiveQuery((query) => query.from({ ticker: tickerCollection }))
  const { data: storedCatalysts = [] } = useLiveQuery((query) => query.from({ catalyst: catalystCollection }))
  const { data: storedWatchlists = [] } = useLiveQuery((query) => query.from({ watchlist: watchlistCollection }))
  const { data: storedResearch = [] } = useLiveQuery((query) => query.from({ research: researchCollection }))
  const { data: preferences = [] } = useLiveQuery((query) => query.from({ preference: preferenceCollection }))
  const { data: syncStates = [] } = useLiveQuery((query) => query.from({ sync: syncStateCollection }))
  const syncState = syncStates.find((candidate) => candidate.id === 'snapshot')
  const snapshotReady = isSnapshotInitialized(syncState)
  const tickers = snapshotReady ? storedTickers : []
  const catalysts = snapshotReady ? storedCatalysts : []
  const watchlists = snapshotReady ? storedWatchlists : []
  const research = snapshotReady ? storedResearch[0] : undefined
  const preference = preferences[0]
  const [tab, setTab] = useState<Tab>('market')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [watchlistEditorOpen, setWatchlistEditorOpen] = useState(false)
  const [bootstrapComplete, setBootstrapComplete] = useState(false)
  const lastSyncAt = useRef(0)
  const syncInFlight = useRef<Promise<void> | undefined>(undefined)
  const syncAbort = useRef<AbortController | undefined>(undefined)
  const syncRevision = useRef(0)
  const closePicker = useCallback(() => setPickerOpen(false), [])
  const openPicker = useCallback(() => setPickerOpen(true), [])
  const closeWatchlistEditor = useCallback(() => setWatchlistEditorOpen(false), [setWatchlistEditorOpen])
  const selectableWatchlists = [
    ...watchlists.filter((watchlist) => watchlist.kind === 'positions'),
    ...watchlists.filter((watchlist) => watchlist.kind === 'private'),
    ...watchlists.filter((watchlist) => watchlist.kind === 'public'),
  ]
  const activeWatchlist = selectableWatchlists.find((watchlist) => watchlist.id === preference?.selectedWatchlistId)
    ?? selectableWatchlists.find((watchlist) => watchlist.kind === 'positions')
    ?? selectableWatchlists[0]
  const selected = tickers.find((ticker) => ticker.symbol === preference?.selectedSymbol)
    ?? tickers.find((ticker) => activeWatchlist?.symbols.includes(ticker.symbol))
    ?? tickers[0]
  const loadedSymbols = new Set(tickers.map((ticker) => ticker.symbol))
  const streamSymbols = selectLiveMarketSymbols(selected?.symbol, activeWatchlist?.symbols ?? [], loadedSymbols)
  useLiveMarket(streamSymbols, snapshotReady)

  const synchronize = useCallback(async (signal?: AbortSignal, force = false): Promise<void> => {
    if (!navigator.onLine) return
    if (force) {
      syncRevision.current += 1
      syncAbort.current?.abort()
    }
    if (syncInFlight.current) {
      await syncInFlight.current
      if (!force || signal?.aborted || !navigator.onLine) return
    }
    const revision = syncRevision.current
    const controller = new AbortController()
    syncAbort.current = controller
    const taskSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const task = syncFromCloud(taskSignal, () => revision === syncRevision.current).then(() => {
      lastSyncAt.current = Date.now()
    }).catch(() => {
      // Keep the local snapshot; focus, reconnect, or an account mutation retries automatically.
    }).finally(() => {
      if (syncInFlight.current === task) {
        syncInFlight.current = undefined
        if (syncAbort.current === controller) syncAbort.current = undefined
      }
    })
    syncInFlight.current = task
    return task
  }, [])

  useEffect(() => {
    const controller = new AbortController()

    void (async () => {
      await restoreOfflineSnapshot()
      void requestPersistentLocalStorage()
      if (!controller.signal.aborted) await synchronize(controller.signal)
      if (!controller.signal.aborted) setBootstrapComplete(true)
    })().catch(() => {
      if (!controller.signal.aborted) setBootstrapComplete(true)
    })
    const online = () => void synchronize(controller.signal)
    const refreshVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastSyncAt.current >= 5 * 60_000) {
        void synchronize(controller.signal)
      }
    }
    window.addEventListener('online', online)
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      controller.abort()
      window.removeEventListener('online', online)
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [synchronize])

  const chooseSymbol = (symbol: string) => {
    selectTicker(symbol)
    setTab('market')
    closePicker()
  }
  const chooseWatchlist = (watchlist: Watchlist) => {
    const fallbackSymbol = selected && watchlist.symbols.includes(selected.symbol)
      ? undefined
      : watchlist.symbols[0]
    selectWatchlist(watchlist.id, fallbackSymbol)
    if (watchlist.kind !== 'private') closeWatchlistEditor()
  }
  const mutateWatchlist = async (action: AggregateWatchlistMutation) => {
    const response = await fetch('/api/watchlists', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    })
    const payload = await response.json().catch(() => ({})) as { error?: unknown }
    if (!response.ok) {
      throw new Error(typeof payload.error === 'string' ? payload.error : 'The watchlist could not be updated')
    }
    await applyWatchlistMutation(action)
    if (snapshotReady) await synchronize(undefined, true)
  }

  const overlayOpen = pickerOpen || watchlistEditorOpen

  return (
    <div className="app-viewport">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="app-shell" aria-hidden={overlayOpen || undefined} inert={overlayOpen}>
        {tab !== 'agent' && (
          <TopBar
            viewerName={viewer?.name}
          />
        )}
        <main id="main-content" className={tab === 'agent' ? 'main-content agent-main' : 'main-content'}>
          {!snapshotReady && (
            <MarketState message={bootstrapComplete ? 'Market data is unavailable.' : 'Loading market data…'} />
          )}
          {snapshotReady && tab === 'market' && selected && activeWatchlist && (
            <MarketScreen
              activeWatchlist={activeWatchlist}
              catalysts={catalysts}
              onManageWatchlist={() => setWatchlistEditorOpen(true)}
              onOpenPicker={openPicker}
              onSelectWatchlist={chooseWatchlist}
              onSelectTicker={chooseSymbol}
              selected={selected}
              tickers={tickers}
              watchlists={watchlists}
            />
          )}
          {snapshotReady && tab === 'market' && (!selected || !activeWatchlist) && (
            <MarketState message="No market symbols are available." />
          )}
          {snapshotReady && tab === 'brief' && research && <BriefScreen brief={research} onSymbol={chooseSymbol} />}
          {snapshotReady && tab === 'brief' && !research && <MarketState message="No research brief is available." />}
          {snapshotReady && tab === 'agent' && selected && <AgentScreen onAccountMutation={() => synchronize(undefined, true)} selected={selected} />}
          {snapshotReady && tab === 'agent' && !selected && <MarketState message="Dan needs a loaded market symbol." />}
        </main>
        <nav className="bottom-nav" aria-label="Primary navigation">
          <button aria-pressed={tab === 'market'} className={tab === 'market' ? 'active' : ''} onClick={() => setTab('market')} type="button"><TrendingUp size={21} /><span>Market</span></button>
          <button aria-pressed={tab === 'brief'} className={tab === 'brief' ? 'active' : ''} onClick={() => setTab('brief')} type="button"><Newspaper size={21} /><span>Brief</span></button>
          <button aria-pressed={tab === 'agent'} className={tab === 'agent' ? 'active' : ''} onClick={() => setTab('agent')} type="button"><Bot size={21} /><span>Dan</span></button>
        </nav>
      </div>
      {pickerOpen && snapshotReady && <TickerPicker onClose={closePicker} onPick={chooseSymbol} tickers={tickers} watchlists={watchlists} />}
      {watchlistEditorOpen && snapshotReady && activeWatchlist?.kind === 'private' && (
        <WatchlistEditor
          onClose={closeWatchlistEditor}
          onMutation={mutateWatchlist}
          tickers={tickers}
          watchlist={activeWatchlist}
        />
      )}
    </div>
  )
}

function MarketState({ message }: { message: string }) {
  return <section aria-live="polite" className="market-state"><p>{message}</p></section>
}
