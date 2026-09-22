import { lazy, Suspense, useCallback, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { Gauge, Newspaper, Plug } from 'lucide-react'
import { z } from 'zod'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import { Skeleton } from '#/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#/components/ui/tabs'
import { selectLiveMarketSymbols, type SnapshotAudience } from '../data/collections'
import { mostActiveSymbol, type PublicSymbolLookup } from '../domain/market'
import { useLiveMarket } from '../data/live-market'
import { useAudienceMarket } from '../data/use-audience-market'
import { useWorkspaceFavorites } from '../data/use-workspace-favorites'
import { OwnerAccessScreen, type Viewer, useViewer } from './auth-gate'
import { MarketScreen } from './market-screen'
import { TopBar } from './top-bar'

const ConnectScreen = lazy(async () => {
  const { ConnectScreen: Screen } = await import('./connect-screen')
  return { default: Screen }
})
const BriefScreen = lazy(async () => {
  const { BriefScreen: Screen } = await import('./brief-screen')
  return { default: Screen }
})

const TabSchema = z.enum(['market', 'recommendations', 'connect'])

type Tab = z.infer<typeof TabSchema>
export function HestonApp() {
  const auth = useViewer()
  // The audience stays unknown until the session check answers. Booting the public surface on
  // a guess discarded the owner's stored snapshot on every refresh — the record belongs to one
  // audience, and restoring for the other throws it away — so a page that already had the
  // market on disk went blank and fetched it again, twice.
  return (
    <HestonWorkspace
      audience={auth.phase === 'ready' ? (auth.user?.role === 'owner' ? 'owner' : 'public') : undefined}
      authError={auth.phase === 'error' ? auth.message : undefined}
      viewer={auth.phase === 'ready' ? auth.user : null}
    />
  )
}

function HestonWorkspace({
  audience,
  authError,
  viewer,
}: {
  audience?: SnapshotAudience
  authError?: string
  viewer: Viewer | null
}) {
  const owner = viewer?.role === 'owner'
  const viewerId = viewer?.id
  const market = useAudienceMarket(audience)
  const { chooseSymbol: saveSelectedSymbol, preference, snapshot, tickers } = market
  const favorites = useWorkspaceFavorites(viewerId, preference)
  const snapshotReady = Boolean(snapshot)
  const catalysts = snapshot?.catalysts ?? []
  const watchlists = snapshot?.watchlists ?? []
  const brief = snapshot?.brief
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
  useLiveMarket(streamSymbols, snapshotReady)
  const collectionFailed = market.collectionFailed || favorites.collectionFailed
  // Reconnect is the feed healing itself. The top bar says Live or Snapshot; a banner
  // for the in-between states would flash on every tab wake.
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
  const chooseSymbol = useCallback((symbol: string, lookup?: PublicSymbolLookup) => {
    void saveSelectedSymbol(symbol, lookup)
    setTab('market')
  }, [saveSelectedSymbol])

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
            nowhere else: on the recommendations or connect tab it would describe something the
            reader is not looking at. */}
        <TopBar
          lastUpdatedAt={tab === 'market' ? lastUpdatedAt : undefined}
          marketClosesAt={snapshot?.marketClosesAt}
          marketOpensAt={snapshot?.marketOpensAt}
          marketState={snapshot?.marketState}
          viewerName={viewer?.name}
        />
        <TabsContent value={tab}>
          <main id="main-content" className="main-content">
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
            {tab === 'connect' && !viewer && <OwnerAccessScreen authError={authError} signedIn={false} />}
            {tab === 'connect' && viewer && (
              <Suspense fallback={<MarketState loading message="Loading…" />}>
                <ConnectScreen owner={owner} />
              </Suspense>
            )}
            {/* The top bar has no room for these on a phone, so the tab about the reader's own
                account carries them for every width. */}
            {tab === 'connect' && (
              <nav aria-label="Legal and support" className="connect-footer">
                <Link to="/support">Support</Link>
                <Link to="/terms">Terms</Link>
                <Link to="/privacy">Privacy</Link>
                <Link to="/disclosures">Disclosures</Link>
              </nav>
            )}
            {/* A failed session check never names an audience, so nothing bootstraps and no sync
                is ever attempted. Saying so — everywhere, not only on the connect tab — is what
                keeps the reader off a spinner that cannot end. The audience is still not guessed:
                restoring for the wrong one would discard the stored snapshot. */}
            {tab !== 'connect' && authError && (
              <Alert variant="destructive">
                <AlertTitle>Session check failed</AlertTitle>
                <AlertDescription>{authError}</AlertDescription>
                <Button onClick={() => window.location.reload()} size="sm" type="button" variant="outline">Try again</Button>
              </Alert>
            )}
            {tab !== 'connect' && !snapshotReady && !authError && (
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
                brief={brief}
                selected={selected}
                tickers={tickers}
              />
            )}
            {snapshotReady && tab === 'market' && (!selected || !activeWatchlist) && (
              <MarketState message="No market symbols are available." />
            )}
            {snapshotReady && tab === 'recommendations' && (
              <Suspense fallback={<MarketState loading message="Loading…" />}>
                <BriefScreen latest={brief} onSymbol={chooseSymbol} />
              </Suspense>
            )}
          </main>
        </TabsContent>
        <TabsList aria-label="Primary navigation" className="bottom-nav">
          <TabsTrigger value="market"><Gauge /><span>Watch</span></TabsTrigger>
          <TabsTrigger value="recommendations"><Newspaper /><span>Recommendations</span></TabsTrigger>
          <TabsTrigger value="connect"><Plug /><span>Connect</span></TabsTrigger>
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
