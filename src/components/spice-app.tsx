import { useCallback, useState } from 'react'
import { Bot, Gauge, Newspaper } from 'lucide-react'
import { z } from 'zod'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import { Skeleton } from '#/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { selectLiveMarketSymbols } from '../data/collections'
import { toError } from '../domain/failure'
import { mostActiveSymbol } from '../domain/market'
import { type WatchlistMutation, WatchlistMutationResultSchema } from '../domain/watchlist'
import { useLiveMarket } from '../data/live-market'
import { useAudienceMarket } from '../data/use-audience-market'
import { useWorkspaceFavorites } from '../data/use-workspace-favorites'
import { AgentScreen } from './agent-screen'
import { OwnerAccessScreen, type Viewer, useViewer } from './auth-gate'
import { BriefScreen } from './brief-screen'
import { MarketScreen } from './market-screen'
import { TopBar } from './top-bar'
import { WatchlistEditor } from './watchlist-editor'

const ApiErrorSchema = z.looseObject({ error: z.string().optional() })
const TabSchema = z.enum(['market', 'brief', 'agent'])

type Tab = z.infer<typeof TabSchema>
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
  const market = useAudienceMarket(audience)
  const { chooseSymbol: saveSelectedSymbol, preference, snapshot, synchronize, tickers } = market
  const favorites = useWorkspaceFavorites(viewerId, preference)
  const snapshotReady = Boolean(snapshot)
  const catalysts = snapshot?.catalysts ?? []
  const watchlists = snapshot?.watchlists ?? []
  const research = snapshot?.research
  const [tab, setTab] = useState<Tab>('market')
  const [watchlistEditorOpen, setWatchlistEditorOpen] = useState(false)
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
  const collectionFailed = market.collectionFailed || favorites.collectionFailed
  const liveWarning = liveMarket.state === 'connecting' || liveMarket.state === 'degraded'
      || liveMarket.state === 'reconnecting'
    ? liveMarket.detail ?? `Live market feed is ${liveMarket.state}.`
    : undefined
  const visibleSnapshotWarning = [
    collectionFailed ? 'Browser market storage failed. Reload to inspect the current state.' : undefined,
    market.warning,
    liveWarning,
  ].filter((warning): warning is string => Boolean(warning)).join(' ') || undefined
  const visibleFavoriteError = favorites.error

  // Stable row callbacks keep the memoized market rows from re-rendering on every
  // workspace render.
  const chooseSymbol = useCallback((symbol: string) => {
    void saveSelectedSymbol(symbol)
    setTab('market')
  }, [saveSelectedSymbol])
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
              <MarketState loading={!market.bootstrapComplete} message={market.bootstrapComplete ? 'Market data is unavailable.' : 'Loading market data…'} />
            )}
            {snapshotReady && tab === 'market' && selected && activeWatchlist && (
              <MarketScreen
                activeWatchlist={activeWatchlist}
                catalysts={catalysts}
                onManageWatchlist={openWatchlistEditor}
                onSelectTicker={chooseSymbol}
                onTogglePinned={favorites.togglePinned}
                pinnedSymbols={favorites.pinnedSymbols}
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
              <MarketState loading={!market.bootstrapComplete} message={market.bootstrapComplete ? 'Account market data is unavailable.' : 'Loading account context…'} />
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
