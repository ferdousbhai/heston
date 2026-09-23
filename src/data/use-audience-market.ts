import { useCallback, useEffect, useState } from 'react'
import { QueryClient, QueryObserver } from '@tanstack/query-core'
import { useLiveQuery } from '@tanstack/react-db'

import { toError } from '../domain/failure'
import { type MarketSnapshot, type PublicSymbolLookup, type Ticker } from '../domain/market'
import { DeploymentMismatchError, reloadForDeployment } from './deployment'
import {
  offlineSnapshotCollection,
  preferenceCollection,
  previewPublicSnapshot,
  restoreOfflineSnapshot,
  selectTicker,
  syncFromCloud,
  tickerCollection,
  type SnapshotAudience,
} from './collections'

/** Public snapshot max-age is 30s. A visible tab refetches on that bound so a new observation lands. */
export const SNAPSHOT_REFETCH_MS = 30 * 1_000

export function snapshotSyncQueryOptions(audience: SnapshotAudience) {
  return {
    queryFn: ({ signal }: { signal?: AbortSignal }) => syncFromCloud(audience, signal),
    queryKey: ['heston-snapshot', audience] as const,
    // Visibility, not window focus: a sitting tab on a second screen is still open.
    refetchInterval: () => document.visibilityState === 'hidden' ? false : SNAPSHOT_REFETCH_MS,
    refetchIntervalInBackground: true,
    refetchOnMount: 'always' as const,
    refetchOnReconnect: 'always' as const,
    refetchOnWindowFocus: 'always' as const,
    retry: false,
    staleTime: 0,
  }
}

type AudienceSnapshotRecord<TSnapshot> = {
  audience: SnapshotAudience
  id: string
  snapshot: TSnapshot
}

export function audienceMarketView<TSnapshot extends MarketSnapshot, TTicker extends Ticker>(
  audience: SnapshotAudience,
  snapshots: readonly AudienceSnapshotRecord<TSnapshot>[],
  tickers: readonly TTicker[],
) {
  const storedSnapshot = snapshots.find((candidate) => candidate.id === 'snapshot')
  // The live ticker collection can still hold the prior audience during a transition.
  // Never expose those rows until the atomic snapshot proves the matching audience.
  const snapshot = storedSnapshot?.audience === audience ? storedSnapshot.snapshot : undefined
  return { snapshot, tickers: snapshot ? [...tickers] : [] }
}

function applySnapshotQueryResult(
  result: { error: unknown; isFetched: boolean },
  setWarning: (warning: string | undefined) => void,
): void {
  if (!result.isFetched) return
  const failure = toError(result.error)
  if (!failure || failure.name === 'AbortError') {
    setWarning(undefined)
    return
  }
  if (failure instanceof DeploymentMismatchError) {
    // The snapshot has already been hydrated when it could be read, so a reload that is
    // declined costs the reader nothing and is not worth a banner. Only a payload this
    // bundle could not parse leaves the screen empty, and the message names the one thing
    // that actually clears it — closing the tab, not the app, which iOS restores.
    if (!reloadForDeployment() && !failure.hydrated) {
      setWarning('Heston needs a newer version. Close this tab and open the site again.')
    }
    return
  }
  // A failed sync is not something to interrupt a reader over: the saved data is still on
  // screen and the last-updated time already says how old it is. Only a failure the reader
  // must act on gets a banner.
  setWarning(undefined)
}

/**
 * `audience` is undefined until the session check resolves. Guessing "public" in the meantime
 * cost the owner their whole view on every refresh: the stored snapshot belongs to one
 * audience, and restoring for the other discards it, so a page that already had the market on
 * disk went blank and refetched. Waiting one session check is cheaper than that, and it also
 * spares the owner a full public sync they never see.
 */
export function useAudienceMarket(audience: SnapshotAudience | undefined) {
  const tickerQuery = useLiveQuery((query) => query.from({ ticker: tickerCollection }))
  const snapshotQuery = useLiveQuery((query) => query.from({ snapshot: offlineSnapshotCollection }))
  const preferenceQuery = useLiveQuery((query) => query.from({ preference: preferenceCollection }))
  const [bootstrappedAudience, setBootstrappedAudience] = useState<SnapshotAudience>()
  const [warning, setWarning] = useState<string>()
  const { snapshot, tickers } = audienceMarketView(
    audience ?? 'public',
    snapshotQuery.data ?? [],
    tickerQuery.data ?? [],
  )
  const preference = (preferenceQuery.data ?? [])[0]

  // A visitor's own cached market has no bearing on who they turn out to be, so it is drawn
  // while the session check runs. An owner's cache waits for the answer.
  useEffect(() => {
    if (audience) return
    void previewPublicSnapshot().catch(() => undefined)
  }, [audience])

  useEffect(() => {
    if (!audience) return
    let cancelled = false
    let unsubscribe = () => {}
    let queryClient: QueryClient | undefined

    void (async () => {
      // Local storage is only one bootstrap source. A corrupt or unavailable offline
      // snapshot must not prevent the independent network recovery path.
      try {
        await restoreOfflineSnapshot(audience)
      } catch {
        if (!cancelled) setWarning('Saved market data could not be restored. Trying the network instead.')
      }
      if (cancelled) return
      // One client per hook instance: query-core focus/reconnect/interval is what pushes a
      // new snapshot into the local collection while this tab stays open.
      queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
      // Focus and reconnect reach a query only through a mounted client. Unmounted, the
      // `refetchOnWindowFocus` and `refetchOnReconnect` below were inert, and a tab brought back
      // after a deploy waited out the interval before it could learn it was running old code.
      queryClient.mount()
      const observer = new QueryObserver(queryClient, snapshotSyncQueryOptions(audience))
      unsubscribe = observer.subscribe((result) => {
        if (cancelled) return
        applySnapshotQueryResult(result, setWarning)
        if (result.isFetched) setBootstrappedAudience(audience)
      })
    })()

    return () => {
      cancelled = true
      unsubscribe()
      queryClient?.unmount()
      queryClient?.clear()
    }
  }, [audience])

  const chooseSymbol = useCallback(async (symbol: string, lookup?: PublicSymbolLookup): Promise<void> => {
    try {
      await selectTicker(symbol, lookup)
    } catch (cause: unknown) {
      setWarning(toError(cause)?.message ?? 'The market selection could not be saved')
    }
  }, [])

  return {
    // An unknown audience has not bootstrapped anything. Comparing two undefined values read
    // as finished, which would report an empty market as unavailable during the session check.
    bootstrapComplete: audience !== undefined && bootstrappedAudience === audience,
    chooseSymbol,
    collectionFailed: tickerQuery.isError || snapshotQuery.isError || preferenceQuery.isError,
    preference,
    snapshot,
    tickers,
    warning,
  }
}
