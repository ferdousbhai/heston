import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { Bot, Gauge, Newspaper } from 'lucide-react'
import { z } from 'zod'

import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import { Skeleton } from '#/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
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
  syncFromCloud,
  syncStateCollection,
  tickerCollection,
  watchlistCollection,
} from '../data/collections'
import {
  createFavoriteSync,
  favoriteStageMarkerCollection,
  stagedFavoriteSymbols,
  toggleFavoriteSymbol,
} from '../data/favorites'
import { toError } from '../domain/failure'
import { type WatchlistMutation, WatchlistMutationResultSchema } from '../domain/watchlist'
import { useLiveMarket } from '../data/live-market'
import { AgentScreen } from './agent-screen'
import { AuthScreen, OwnerAccessScreen, type Viewer, useViewer } from './auth-gate'
import { BriefScreen } from './brief-screen'
import { MarketScreen } from './market-screen'
import { TopBar } from './top-bar'
import { WatchlistEditor } from './watchlist-editor'

const ApiErrorSchema = z.looseObject({ error: z.string().optional() })
const TabSchema = z.enum(['market', 'brief', 'agent'])

type Tab = z.infer<typeof TabSchema>

export function SpiceApp() {
  const auth = useViewer()
  if (auth.phase === 'checking') return <AuthScreen checking />
  return (
    <SpiceWorkspace
      authError={auth.phase === 'error' ? auth.message : undefined}
      viewer={auth.phase === 'ready' ? auth.user : null}
    />
  )
}

function SpiceWorkspace({ authError, viewer }: { authError?: string; viewer: Viewer | null }) {
  const owner = viewer?.role === 'owner'
  const viewerId = viewer?.id
  const audience = owner ? 'owner' : 'public'
  const favoriteSync = useMemo(
    () => viewerId ? createFavoriteSync(viewerId) : undefined,
    [viewerId],
  )
  const { data: storedTickers = [] } = useLiveQuery((query) => query.from({ ticker: tickerCollection }))
  const { data: storedCatalysts = [] } = useLiveQuery((query) => query.from({ catalyst: catalystCollection }))
  const { data: storedWatchlists = [] } = useLiveQuery((query) => query.from({ watchlist: watchlistCollection }))
  const { data: storedResearch = [] } = useLiveQuery((query) => query.from({ research: researchCollection }))
  const { data: preferences = [] } = useLiveQuery((query) => query.from({ preference: preferenceCollection }))
  const { data: favoriteStageMarkers = [] } = useLiveQuery(
    (query) => query.from({ favoriteStageMarker: favoriteStageMarkerCollection }),
  )
  const { data: syncStates = [] } = useLiveQuery((query) => query.from({ sync: syncStateCollection }))
  const { data: syncedFavorites } = useLiveQuery(
    () => favoriteSync?.collection,
    [favoriteSync],
  )
  const syncState = syncStates.find((candidate) => candidate.id === 'snapshot')
  const snapshotReady = isSnapshotInitialized(syncState, audience)
  const tickers = snapshotReady ? storedTickers : []
  const catalysts = snapshotReady ? storedCatalysts : []
  const watchlists = snapshotReady ? storedWatchlists : []
  const research = snapshotReady ? storedResearch[0] : undefined
  const preference = preferences[0]
  const favoriteStageMarker = favoriteStageMarkers[0]
  const pinnedSymbols = favoriteSync
    ? (syncedFavorites ?? []).map((favorite) => favorite.symbol)
    : stagedFavoriteSymbols(preference, favoriteStageMarker)
  const [tab, setTab] = useState<Tab>('market')
  const [watchlistEditorOpen, setWatchlistEditorOpen] = useState(false)
  const [bootstrappedAudience, setBootstrappedAudience] = useState<'owner' | 'public'>()
  const bootstrapComplete = bootstrappedAudience === audience
  const lastSyncAt = useRef(0)
  const syncInFlight = useRef<Promise<void> | undefined>(undefined)
  const syncInFlightAudience = useRef<typeof audience | undefined>(undefined)
  const syncAbort = useRef<AbortController | undefined>(undefined)
  const syncRevision = useRef(0)
  const closeWatchlistEditor = useCallback(() => setWatchlistEditorOpen(false), [setWatchlistEditorOpen])
  // One D1-backed watchlist reaches each audience; the preference only survives
  // so a stale stored id cannot outrank the list the snapshot actually carries.
  const activeWatchlist = watchlists.find((watchlist) => watchlist.id === preference?.selectedWatchlistId)
    ?? watchlists[0]
  const selected = tickers.find((ticker) => ticker.symbol === preference?.selectedSymbol)
    ?? tickers.find((ticker) => activeWatchlist?.symbols.includes(ticker.symbol))
    ?? tickers[0]
  const loadedSymbols = new Set(tickers.map((ticker) => ticker.symbol))
  const streamSymbols = selectLiveMarketSymbols(selected?.symbol, activeWatchlist?.symbols ?? [], loadedSymbols)
  useLiveMarket(streamSymbols, snapshotReady && owner)

  const synchronize = useCallback(async (signal?: AbortSignal, force = false): Promise<void> => {
    if (!navigator.onLine) return
    if (force) {
      syncRevision.current += 1
      syncAbort.current?.abort()
    }
    if (syncInFlight.current) {
      const activeAudience = syncInFlightAudience.current
      await syncInFlight.current
      if ((!force && activeAudience === audience) || signal?.aborted || !navigator.onLine) return
    }
    const revision = syncRevision.current
    const controller = new AbortController()
    syncAbort.current = controller
    const taskSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const task = syncFromCloud(taskSignal, () => revision === syncRevision.current, audience).then(() => {
      lastSyncAt.current = Date.now()
    }).catch(() => {
      // Keep the local snapshot; focus, reconnect, or an account mutation retries automatically.
    }).finally(() => {
      if (syncInFlight.current === task) {
        syncInFlight.current = undefined
        syncInFlightAudience.current = undefined
        if (syncAbort.current === controller) syncAbort.current = undefined
      }
    })
    syncInFlight.current = task
    syncInFlightAudience.current = audience
    return task
  }, [audience])

  useEffect(() => {
    const controller = new AbortController()

    void (async () => {
      await restoreOfflineSnapshot(audience)
      void requestPersistentLocalStorage()
      if (!controller.signal.aborted) await synchronize(controller.signal)
      if (!controller.signal.aborted) setBootstrappedAudience(audience)
    })().catch(() => {
      if (!controller.signal.aborted) setBootstrappedAudience(audience)
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
  }, [audience, synchronize])

  const chooseSymbol = (symbol: string) => {
    selectTicker(symbol)
    setTab('market')
  }
  const mutateWatchlist = async (action: WatchlistMutation) => {
    if (!owner) throw new Error('Owner authentication is required')
    const response = await fetch('/api/watchlists', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    })
    const payload = await response.json().catch(() => ({}))
    const result = WatchlistMutationResultSchema.safeParse(payload).data
    const apiError = ApiErrorSchema.safeParse(payload).data
    if (!response.ok) {
      // A typed zero-apply capacity rejection changed no server state. Avoid a
      // needless snapshot reconciliation that can erase the rejected form value.
      if (snapshotReady && (!result || result.appliedSymbols.length > 0)) {
        await synchronize(undefined, true).catch(() => undefined)
      }
      throw new Error(result?.detail ?? apiError?.error ?? 'The watchlist could not be updated')
    }
    await applyWatchlistMutation(action)
    if (snapshotReady) await synchronize(undefined, true)
  }

  const overlayOpen = watchlistEditorOpen
  const ownerAgentOpen = tab === 'agent' && owner

  return (
    <div className="app-viewport">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Tabs
        className="app-shell"
        aria-hidden={overlayOpen || undefined}
        inert={overlayOpen}
        onValueChange={(value) => {
          const parsed = TabSchema.safeParse(value)
          if (parsed.success) setTab(parsed.data)
        }}
        value={tab}
      >
        {!ownerAgentOpen && (
          <TopBar
            viewerName={viewer?.name}
          />
        )}
        <TabsContent value={tab}>
          <main id="main-content" className={ownerAgentOpen ? 'main-content agent-main' : 'main-content'}>
            {tab === 'agent' && !owner && <OwnerAccessScreen authError={authError} signedIn={Boolean(viewer)} />}
            {tab !== 'agent' && !snapshotReady && (
              <MarketState loading={!bootstrapComplete} message={bootstrapComplete ? 'Market data is unavailable.' : 'Loading market data…'} />
            )}
            {snapshotReady && tab === 'market' && selected && activeWatchlist && (
              <MarketScreen
                activeWatchlist={activeWatchlist}
                catalysts={catalysts}
                onManageWatchlist={() => setWatchlistEditorOpen(true)}
                onSelectTicker={chooseSymbol}
                onTogglePinned={(symbol) => void toggleFavoriteSymbol(symbol, favoriteSync).catch((cause: unknown) => {
                  console.error('FavoriteMutationFailed', toError(cause)?.message ?? 'UnknownError')
                })}
                pinnedSymbols={pinnedSymbols}
                research={research}
                selected={selected}
                tickers={tickers}
              />
            )}
            {snapshotReady && tab === 'market' && (!selected || !activeWatchlist) && (
              <MarketState message="No market symbols are available." />
            )}
            {snapshotReady && tab === 'brief' && research && (
              <BriefScreen availableSymbols={loadedSymbols} brief={research} onSymbol={chooseSymbol} />
            )}
            {snapshotReady && tab === 'brief' && !research && <MarketState message="No research brief is available." />}
            {owner && !snapshotReady && tab === 'agent' && (
              <MarketState loading={!bootstrapComplete} message={bootstrapComplete ? 'Account market data is unavailable.' : 'Loading account context…'} />
            )}
            {owner && snapshotReady && tab === 'agent' && selected && <AgentScreen onAccountMutation={() => synchronize(undefined, true)} selected={selected} />}
            {owner && snapshotReady && tab === 'agent' && !selected && <MarketState message="Dan needs a loaded market symbol." />}
          </main>
        </TabsContent>
        <TabsList aria-label="Primary navigation" className="bottom-nav">
          <TabsTrigger value="market"><Gauge /><span>Watch</span></TabsTrigger>
          <TabsTrigger value="brief"><Newspaper /><span>Daily read</span></TabsTrigger>
          <TabsTrigger value="agent"><Bot /><span>Dan</span></TabsTrigger>
        </TabsList>
      </Tabs>
      {owner && watchlistEditorOpen && snapshotReady && activeWatchlist?.kind === 'private' && (
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

function MarketState({ loading = false, message }: { loading?: boolean; message: string }) {
  if (loading) {
    return (
      <section aria-busy="true" aria-live="polite" className="market-state">
        <div className="market-state-loading" role="status">
          <Skeleton />
          <Skeleton />
          <p>{message}</p>
        </div>
      </section>
    )
  }
  return (
    <section aria-live="polite" className="market-state">
      <Empty><EmptyHeader><EmptyDescription>{message}</EmptyDescription></EmptyHeader></Empty>
    </section>
  )
}
