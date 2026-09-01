import { useCallback, useState } from 'react'
import { Bot, Gauge, Newspaper } from 'lucide-react'
import { z } from 'zod'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import { Skeleton } from '#/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { selectLiveMarketSymbols } from '../data/collections'
import { mostActiveSymbol } from '../domain/market'
import { useLiveMarket } from '../data/live-market'
import { useAudienceMarket } from '../data/use-audience-market'
import { useWorkspaceFavorites } from '../data/use-workspace-favorites'
import { AgentScreen } from './agent-screen'
import { OwnerAccessScreen, type Viewer, useViewer } from './auth-gate'
import { RecommendationScreen } from './recommendation-screen'
import { MarketScreen } from './market-screen'
import { TopBar } from './top-bar'

const TabSchema = z.enum(['market', 'recommendations', 'agent'])

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
  const dailyRecommendations = snapshot?.recommendations
  const [tab, setTab] = useState<Tab>('market')
  // One D1-backed watchlist reaches each audience; the preference only survives
  // so a stale stored id cannot outrank the list the snapshot actually carries.
  const activeWatchlist = watchlists.find((watchlist) => watchlist.id === preference?.selectedWatchlistId)
    ?? watchlists[0]
  const fallbackSymbol = mostActiveSymbol(tickers, activeWatchlist?.symbols)
  const selected = tickers.find((ticker) => ticker.symbol === preference?.selectedSymbol)
    ?? tickers.find((ticker) => ticker.symbol === fallbackSymbol)
  const loadedSymbols = new Set(tickers.map((ticker) => ticker.symbol))
  const streamSymbols = selectLiveMarketSymbols(selected?.symbol, activeWatchlist?.symbols ?? [], loadedSymbols)
  // Called for the subscription it opens; its transient states are no longer surfaced.
  useLiveMarket(streamSymbols, snapshotReady && owner)
  const collectionFailed = market.collectionFailed || favorites.collectionFailed
  // A reconnect is the feed healing itself, and it happens whenever a tab wakes or a socket
  // drops. Alerting on it made the banner flash on and off over nothing. Feed health is now
  // told by how old the data is, and only a failure the reader must act on interrupts them.
  const visibleSnapshotWarning = [
    collectionFailed ? 'Browser market storage failed. Reload to inspect the current state.' : undefined,
    market.warning,
  ].filter((warning): warning is string => Boolean(warning)).join(' ') || undefined
  // Live ticks move a ticker's own instant past the snapshot's, so the freshest reading in
  // hand is what the reader is actually looking at.
  const lastUpdatedAt = [snapshot?.syncedAt, ...tickers.map((ticker) => ticker.updatedAt)]
    .filter((at): at is string => Boolean(at))
    .reduce<string | undefined>((newest, at) => (newest === undefined || at > newest ? at : newest), undefined)
  const visibleFavoriteError = favorites.error

  // Stable row callbacks keep the memoized market rows from re-rendering on every
  // workspace render.
  const chooseSymbol = useCallback((symbol: string) => {
    void saveSelectedSymbol(symbol)
    setTab('market')
  }, [saveSelectedSymbol])
  const ownerAgentOpen = tab === 'agent' && owner

  return (
    <div className="app-viewport">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Tabs
        className="app-shell"
        onValueChange={(value) => {
          const parsed = TabSchema.safeParse(value)
          if (parsed.success) setTab(parsed.data)
        }}
        value={tab}
      >
        {/* The age belongs to the market data, so it is stated where that data is read and
            nowhere else: on the recommendations or agent tab it would describe something the
            reader is not looking at. */}
        {!ownerAgentOpen && (
          <TopBar
            lastUpdatedAt={tab === 'market' ? lastUpdatedAt : undefined}
            marketOpensAt={snapshot?.marketOpensAt}
            marketState={snapshot?.marketState}
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
                owner={owner}
                onSelectTicker={chooseSymbol}
                onTogglePinned={favorites.togglePinned}
                pinnedSymbols={favorites.pinnedSymbols}
                dailyRecommendations={dailyRecommendations}
                selected={selected}
                tickers={tickers}
              />
            )}
            {snapshotReady && tab === 'market' && (!selected || !activeWatchlist) && (
              <MarketState message="No market symbols are available." />
            )}
            {snapshotReady && tab === 'recommendations' && (
              <RecommendationScreen
                availableSymbols={loadedSymbols}
                dailyRecommendations={dailyRecommendations}
                onSymbol={chooseSymbol}
              />
            )}
            {owner && !snapshotReady && tab === 'agent' && (
              <MarketState loading={!market.bootstrapComplete} message={market.bootstrapComplete ? 'Account market data is unavailable.' : 'Loading account context…'} />
            )}
            {owner && snapshotReady && tab === 'agent' && selected && <AgentScreen onAccountMutation={() => synchronize(undefined, true)} selected={selected} />}
            {owner && snapshotReady && tab === 'agent' && !selected && <MarketState message="Dan needs a loaded market symbol." />}
          </main>
        </TabsContent>
        <TabsList aria-label="Primary navigation" className="bottom-nav">
          <TabsTrigger value="market"><Gauge /><span>Watch</span></TabsTrigger>
          <TabsTrigger value="recommendations"><Newspaper /><span>Recommendations</span></TabsTrigger>
          <TabsTrigger value="agent"><Bot /><span>Dan</span></TabsTrigger>
        </TabsList>
      </Tabs>
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
