import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { Bot, Newspaper, TrendingUp } from 'lucide-react'

import {
  ensureOfflineSnapshot,
  preferenceCollection,
  researchCollection,
  selectTicker,
  selectWatchlist,
  syncFromCloud,
  syncStateCollection,
  tickerCollection,
  watchlistCollection,
} from '../data/collections'
import { demoResearch, demoTickers, demoWatchlists } from '../domain/demo'
import { type Watchlist } from '../domain/market'
import { AgentScreen } from './agent-screen'
import { BriefScreen } from './brief-screen'
import { MarketScreen } from './market-screen'
import { TickerPicker } from './ticker-picker'
import { TopBar, type SyncPhase } from './top-bar'

type Tab = 'market' | 'brief' | 'agent'

export function SpiceApp() {
  const { data: storedTickers = [] } = useLiveQuery((query) => query.from({ ticker: tickerCollection }))
  const { data: storedWatchlists = [] } = useLiveQuery((query) => query.from({ watchlist: watchlistCollection }))
  const { data: storedResearch = [] } = useLiveQuery((query) => query.from({ research: researchCollection }))
  const { data: preferences = [] } = useLiveQuery((query) => query.from({ preference: preferenceCollection }))
  const { data: syncStates = [] } = useLiveQuery((query) => query.from({ sync: syncStateCollection }))
  const tickers = storedTickers.length ? storedTickers : demoTickers
  const watchlists = storedWatchlists.length ? storedWatchlists : demoWatchlists
  const research = storedResearch[0] ?? demoResearch
  const preference = preferences[0]
  const [tab, setTab] = useState<Tab>('market')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [phase, setPhase] = useState<SyncPhase>('idle')
  const fallbackWatchlist = watchlists[0] ?? demoWatchlists[0]!
  const activeWatchlist = watchlists.find((watchlist) => watchlist.id === preference?.selectedWatchlistId) ?? fallbackWatchlist
  const selected = tickers.find((ticker) => ticker.symbol === preference?.selectedSymbol)
    ?? tickers.find((ticker) => activeWatchlist.symbols.includes(ticker.symbol))
    ?? tickers[0] ?? demoTickers[0]!
  const source = syncStates[0]?.source ?? 'demo'

  const synchronize = useMemo(() => async () => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setPhase('offline')
      return
    }
    setPhase('syncing')
    try {
      await syncFromCloud()
      setPhase('idle')
    } catch {
      setPhase(typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'error')
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void ensureOfflineSnapshot().then(() => { if (!cancelled) return synchronize() })
    const online = () => void synchronize()
    const offline = () => setPhase('offline')
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => {
      cancelled = true
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    }
  }, [synchronize])

  const chooseSymbol = (symbol: string) => {
    selectTicker(symbol)
    setTab('market')
    setPickerOpen(false)
  }
  const chooseFromPicker = (watchlist: Watchlist, symbol: string) => {
    selectWatchlist(watchlist.id, symbol)
    setPickerOpen(false)
  }

  return (
    <div className="app-viewport">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="app-shell">
        {tab !== 'agent' && <TopBar phase={phase} source={source} onSync={() => void synchronize()} />}
        <main id="main-content" className={tab === 'agent' ? 'main-content agent-main' : 'main-content'}>
          {tab === 'market' && (
            <MarketScreen
              activeWatchlist={activeWatchlist}
              onAskDan={() => setTab('agent')}
              onOpenPicker={() => setPickerOpen(true)}
              onSelectTicker={chooseSymbol}
              selected={selected}
              tickers={tickers}
            />
          )}
          {tab === 'brief' && <BriefScreen brief={research} onSymbol={chooseSymbol} />}
          {tab === 'agent' && <AgentScreen selected={selected} />}
        </main>
        <nav className="bottom-nav" aria-label="Primary navigation">
          <button className={tab === 'market' ? 'active' : ''} onClick={() => setTab('market')} type="button"><TrendingUp size={21} /><span>Market</span></button>
          <button className={tab === 'brief' ? 'active' : ''} onClick={() => setTab('brief')} type="button"><Newspaper size={21} /><span>Brief</span></button>
          <button className={tab === 'agent' ? 'active' : ''} onClick={() => setTab('agent')} type="button"><Bot size={21} /><span>Dan</span></button>
        </nav>
      </div>
      {pickerOpen && <TickerPicker onClose={() => setPickerOpen(false)} onPick={chooseFromPicker} tickers={tickers} watchlists={watchlists} />}
    </div>
  )
}
