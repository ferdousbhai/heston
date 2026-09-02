import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'

import { toError } from '../domain/failure'
import { type MarketSnapshot, type Ticker } from '../domain/market'
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

type SnapshotSyncOperation = {
  audience: SnapshotAudience
  controller: AbortController
  promise: Promise<void>
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
  const syncOperation = useRef<SnapshotSyncOperation | undefined>(undefined)
  const { snapshot, tickers } = audienceMarketView(
    audience ?? 'public',
    snapshotQuery.data ?? [],
    tickerQuery.data ?? [],
  )
  const preference = (preferenceQuery.data ?? [])[0]

  const synchronize = useCallback(async (signal?: AbortSignal, force = false): Promise<void> => {
    // Nothing may be fetched before the session check names the audience it belongs to.
    if (!audience) return
    // No `navigator.onLine` gate: WebKit on iOS reports offline for connected devices often
    // enough that the gate held a phone on its saved market, silently, for as long as the tab
    // lived. A request that fails is the only reliable answer, and it costs nothing offline.
    const active = syncOperation.current
    if (active) {
      if (!force && active.audience === audience) return active.promise
      active.controller.abort()
    }
    const controller = new AbortController()
    const taskSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let operation!: SnapshotSyncOperation
    const task = syncFromCloud(taskSignal, () => syncOperation.current === operation, audience).then(() => {
      setWarning(undefined)
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
      if (failure instanceof DeploymentMismatchError) {
        // The snapshot has already been hydrated when it could be read, so a reload that is
        // declined costs the reader nothing and is not worth a banner. Only a payload this
        // bundle could not parse leaves the screen empty, and the message names the one thing
        // that actually clears it — closing the tab, not the app, which iOS restores.
        if (!reloadForDeployment() && !failure.hydrated) {
          setWarning('Spice needs a newer version. Close this tab and open the site again.')
        }
        return
      }
      // A failed sync is not something to interrupt a reader over: the saved data is still on
      // screen and the last-updated time already says how old it is. Only a failure the reader
      // must act on gets a banner.
      setWarning(undefined)
    }
  }, [synchronize])

  // A visitor's own cached market has no bearing on who they turn out to be, so it is drawn
  // while the session check runs. An owner's cache waits for the answer.
  useEffect(() => {
    if (audience) return
    void previewPublicSnapshot().catch(() => undefined)
  }, [audience])

  useEffect(() => {
    if (!audience) return
    const controller = new AbortController()

    void (async () => {
      // Local storage is only one bootstrap source. A corrupt or unavailable offline
      // snapshot must not prevent the independent network recovery path.
      try {
        await restoreOfflineSnapshot(audience)
      } catch {
        if (!controller.signal.aborted) {
          setWarning('Saved market data could not be restored. Trying the network instead.')
        }
      }
      if (!controller.signal.aborted) await synchronizeWithWarning(controller.signal)
      if (!controller.signal.aborted) setBootstrappedAudience(audience)
    })()
    const online = () => void synchronizeWithWarning(controller.signal)
    const offline = () => {
      setWarning(undefined)
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

  const chooseSymbol = useCallback(async (symbol: string): Promise<void> => {
    try {
      await selectTicker(symbol)
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
    synchronize,
    tickers,
    warning,
  }
}
