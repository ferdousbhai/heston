import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'
import { Bot, Gauge, Newspaper } from 'lucide-react'
import { z } from 'zod'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import { Skeleton } from '#/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import {
  offlineSnapshotCollection,
  preferenceCollection,
  restoreOfflineSnapshot,
  selectTicker,
  selectLiveMarketSymbols,
  syncFromCloud,
  tickerCollection,
} from '../data/collections'
import {
  createFavoriteSync,
  favoriteStageMarkerCollection,
  stagedFavoriteSymbols,
  toggleFavoriteSymbol,
} from '../data/favorites'
import { toError } from '../domain/failure'
import { mostActiveSymbol } from '../domain/market'
import { type WatchlistMutation, WatchlistMutationResultSchema } from '../domain/watchlist'
import { useLiveMarket } from '../data/live-market'
import { AgentScreen } from './agent-screen'
import { OwnerAccessScreen, type Viewer, useViewer } from './auth-gate'
import { BriefScreen } from './brief-screen'
import { MarketScreen } from './market-screen'
import { TopBar } from './top-bar'
import { WatchlistEditor } from './watchlist-editor'

const ApiErrorSchema = z.looseObject({ error: z.string().optional() })
const TabSchema = z.enum(['market', 'brief', 'agent'])

type Tab = z.infer<typeof TabSchema>
type SnapshotSyncOperation = {
  audience: 'owner' | 'public'
  controller: AbortController
  promise: Promise<void>
}

export function SpiceApp() {
  const auth = useViewer()
  // Boot the source-neutral public surface while the session check is in flight
  // instead of holding the whole app behind it. If the viewer turns out to be the
  // owner, the audience-tagged atomic snapshot keeps public rows from ever being
  // rendered as the private snapshot; the workspace re-syncs for that audience.
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
  const tickerQuery = useLiveQuery((query) => query.from({ ticker: tickerCollection }))
  const snapshotQuery = useLiveQuery((query) => query.from({ snapshot: offlineSnapshotCollection }))
  const preferenceQuery = useLiveQuery((query) => query.from({ preference: preferenceCollection }))
  const favoriteStageQuery = useLiveQuery(
    (query) => query.from({ favoriteStageMarker: favoriteStageMarkerCollection }),
  )
  const favoriteQuery = useLiveQuery(
    () => favoriteSync?.collection,
    [favoriteSync],
  )
  const storedTickers = tickerQuery.data ?? []
  const storedSnapshots = snapshotQuery.data ?? []
  const preferences = preferenceQuery.data ?? []
  const favoriteStageMarkers = favoriteStageQuery.data ?? []
  const storedSnapshot = storedSnapshots.find((candidate) => candidate.id === 'snapshot')
  const snapshot = storedSnapshot?.audience === audience ? storedSnapshot.snapshot : undefined
  const snapshotReady = Boolean(snapshot)
  const tickers = snapshotReady ? storedTickers : []
  const catalysts = snapshot?.catalysts ?? []
  const watchlists = snapshot?.watchlists ?? []
  const research = snapshot?.research
  const preference = preferences[0]
  const favoriteStageMarker = favoriteStageMarkers[0]
  const pinnedSymbols = favoriteSync
    ? (favoriteQuery.data ?? []).map((favorite) => favorite.symbol)
    : stagedFavoriteSymbols(preference, favoriteStageMarker)
  const [tab, setTab] = useState<Tab>('market')
  const [watchlistEditorOpen, setWatchlistEditorOpen] = useState(false)
  const [bootstrappedAudience, setBootstrappedAudience] = useState<'owner' | 'public'>()
  const [favoriteError, setFavoriteError] = useState<string>()
  const [snapshotWarning, setSnapshotWarning] = useState<string>()
  const bootstrapComplete = bootstrappedAudience === audience
  const syncOperation = useRef<SnapshotSyncOperation | undefined>(undefined)
  const closeWatchlistEditor = useCallback(() => setWatchlistEditorOpen(false), [setWatchlistEditorOpen])
  const openWatchlistEditor = useCallback(() => setWatchlistEditorOpen(true), [setWatchlistEditorOpen])
  // One D1-backed watchlist reaches each audience; the preference only survives
  // so a stale stored id cannot outrank the list the snapshot actually carries.
  const activeWatchlist = watchlists.find((watchlist) => watchlist.id === preference?.selectedWatchlistId)
    ?? watchlists[0]
  const fallbackSymbol = mostActiveSymbol(tickers, activeWatchlist?.symbols)
  const selected = tickers.find((ticker) => ticker.symbol === preference?.selectedSymbol)
    ?? tickers.find((ticker) => ticker.symbol === fallbackSymbol)
  const loadedSymbols = new Set(tickers.map((ticker) => ticker.symbol))
  const streamSymbols = selectLiveMarketSymbols(selected?.symbol, activeWatchlist?.symbols ?? [], loadedSymbols)
  const liveMarket = useLiveMarket(streamSymbols, snapshotReady && owner)
  const collectionFailed = tickerQuery.isError || snapshotQuery.isError || preferenceQuery.isError
    || favoriteStageQuery.isError
  const liveWarning = liveMarket.state === 'connecting' || liveMarket.state === 'degraded'
      || liveMarket.state === 'reconnecting'
    ? liveMarket.detail ?? `Live market feed is ${liveMarket.state}.`
    : undefined
  const visibleSnapshotWarning = [
    collectionFailed ? 'Browser market storage failed. Reload to inspect the current state.' : undefined,
    snapshotWarning,
    liveWarning,
  ].filter((warning): warning is string => Boolean(warning)).join(' ') || undefined
  const visibleFavoriteError = favoriteSync && favoriteQuery.isError
    ? 'Favorite synchronization failed.'
    : favoriteError

  const synchronize = useCallback(async (signal?: AbortSignal, force = false): Promise<void> => {
    if (!navigator.onLine) throw new Error('Market synchronization is unavailable while offline')
    const active = syncOperation.current
    if (active) {
      if (!force && active.audience === audience) return active.promise
      active.controller.abort()
    }
    const controller = new AbortController()
    const taskSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let operation!: SnapshotSyncOperation
    const task = syncFromCloud(taskSignal, () => syncOperation.current === operation, audience).then(() => {
      setSnapshotWarning(undefined)
    })
    operation = { audience, controller, promise: task }
    syncOperation.current = operation
    try {
      await task
    } finally {
      if (syncOperation.current === operation) syncOperation.current = undefined
    }
  }, [audience])

  const synchronizeWithWarning = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      await synchronize(signal)
    } catch (cause: unknown) {
      const failure = toError(cause)
      if (signal?.aborted || failure?.name === 'AbortError') return
      setSnapshotWarning(navigator.onLine
        ? 'Latest market data could not be synchronized. Showing saved data when available.'
        : 'Live market updates are paused while offline. Showing saved data when available.')
    }
  }, [setSnapshotWarning, synchronize])

  useEffect(() => {
    const controller = new AbortController()

    void (async () => {
      // Local storage is only one bootstrap source. A corrupt or unavailable offline
      // snapshot must not prevent the independent network recovery path.
      try {
        await restoreOfflineSnapshot(audience)
      } catch {
        if (!controller.signal.aborted) {
          setSnapshotWarning('Saved market data could not be restored. Trying the network instead.')
        }
      }
      if (!controller.signal.aborted) await synchronizeWithWarning(controller.signal)
      if (!controller.signal.aborted) setBootstrappedAudience(audience)
    })()
    const online = () => void synchronizeWithWarning(controller.signal)
    const offline = () => {
      setSnapshotWarning('Live market updates are paused while offline. Showing saved data when available.')
    }
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') void synchronizeWithWarning(controller.signal)
    }
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    window.addEventListener('focus', refreshVisible)
    document.addEventListener('visibilitychange', refreshVisible)
    return () => {
      controller.abort()
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
      window.removeEventListener('focus', refreshVisible)
      document.removeEventListener('visibilitychange', refreshVisible)
    }
  }, [audience, synchronizeWithWarning])

  // Stable row callbacks keep the memoized market rows from re-rendering on every
  // workspace render.
  const chooseSymbol = useCallback((symbol: string) => {
    void selectTicker(symbol).catch((cause: unknown) => {
      setSnapshotWarning(toError(cause)?.message ?? 'The market selection could not be saved')
    })
    setTab('market')
  }, [setSnapshotWarning, setTab])
  const togglePinned = useCallback((symbol: string) => {
    setFavoriteError(undefined)
    void toggleFavoriteSymbol(symbol, favoriteSync).catch((cause: unknown) => {
      setFavoriteError(toError(cause)?.message ?? 'The favorite could not be updated')
    })
  }, [favoriteSync, setFavoriteError])
  const mutateWatchlist = async (action: WatchlistMutation) => {
    if (!owner) throw new Error('Owner authentication is required')
    const response = await fetch('/api/watchlists', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    })
    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw new Error(`Watchlist update returned invalid JSON (${response.status})`)
    }
    const result = WatchlistMutationResultSchema.safeParse(payload).data
    const apiError = ApiErrorSchema.safeParse(payload).data
    if (!response.ok) {
      // A typed zero-apply capacity rejection changed no server state. Avoid a
      // needless snapshot reconciliation that can erase the rejected form value.
      if (snapshotReady && (!result || result.appliedSymbols.length > 0)) {
        try {
          await synchronize(undefined, true)
        } catch (cause: unknown) {
          const refreshFailure = toError(cause)
          if (refreshFailure?.name === 'AbortError') {
            throw new Error(result?.detail ?? apiError?.error ?? 'The watchlist could not be updated')
          }
          const refreshDetail = refreshFailure?.message ?? 'Unknown refresh failure'
          throw new Error(`${result?.detail ?? apiError?.error ?? 'The watchlist could not be updated'}. Refresh also failed: ${refreshDetail}`)
        }
      }
      throw new Error(result?.detail ?? apiError?.error ?? 'The watchlist could not be updated')
    }
    WatchlistMutationResultSchema.parse(payload)
    if (snapshotReady) {
      try {
        await synchronize(undefined, true)
      } catch (cause: unknown) {
        const refreshFailure = toError(cause)
        if (refreshFailure?.name === 'AbortError') return
        throw new Error(refreshFailure?.message ?? 'The updated watchlist could not be refreshed')
      }
    }
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
            {visibleSnapshotWarning && (
              <Alert>
                <AlertTitle>Market data may be stale</AlertTitle>
                <AlertDescription>{visibleSnapshotWarning}</AlertDescription>
              </Alert>
            )}
            {tab === 'market' && visibleFavoriteError && (
              <Alert variant="destructive">
                <AlertTitle>Favorite update failed</AlertTitle>
                <AlertDescription>{visibleFavoriteError}</AlertDescription>
              </Alert>
            )}
            {tab === 'agent' && !owner && <OwnerAccessScreen authError={authError} signedIn={Boolean(viewer)} />}
            {tab !== 'agent' && !snapshotReady && (
              <MarketState loading={!bootstrapComplete} message={bootstrapComplete ? 'Market data is unavailable.' : 'Loading market data…'} />
            )}
            {snapshotReady && tab === 'market' && selected && activeWatchlist && (
              <MarketScreen
                activeWatchlist={activeWatchlist}
                catalysts={catalysts}
                onManageWatchlist={openWatchlistEditor}
                onSelectTicker={chooseSymbol}
                onTogglePinned={togglePinned}
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
          <TabsTrigger value="brief"><Newspaper /><span>Brief</span></TabsTrigger>
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
