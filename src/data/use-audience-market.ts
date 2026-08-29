import { useCallback, useEffect, useRef, useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'

import { toError } from '../domain/failure'
import { type MarketSnapshot, type Ticker } from '../domain/market'
import {
  offlineSnapshotCollection,
  preferenceCollection,
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

export function useAudienceMarket(audience: SnapshotAudience) {
  const tickerQuery = useLiveQuery((query) => query.from({ ticker: tickerCollection }))
  const snapshotQuery = useLiveQuery((query) => query.from({ snapshot: offlineSnapshotCollection }))
  const preferenceQuery = useLiveQuery((query) => query.from({ preference: preferenceCollection }))
  const [bootstrappedAudience, setBootstrappedAudience] = useState<SnapshotAudience>()
  const [warning, setWarning] = useState<string>()
  const syncOperation = useRef<SnapshotSyncOperation | undefined>(undefined)
  const { snapshot, tickers } = audienceMarketView(
    audience,
    snapshotQuery.data ?? [],
    tickerQuery.data ?? [],
  )
  const preference = (preferenceQuery.data ?? [])[0]

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
      setWarning(navigator.onLine
        ? 'Latest market data could not be synchronized. Showing saved data when available.'
        : 'Live market updates are paused while offline. Showing saved data when available.')
    }
  }, [synchronize])

  useEffect(() => {
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
      setWarning('Live market updates are paused while offline. Showing saved data when available.')
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
    bootstrapComplete: bootstrappedAudience === audience,
    chooseSymbol,
    collectionFailed: tickerQuery.isError || snapshotQuery.isError || preferenceQuery.isError,
    preference,
    snapshot,
    synchronize,
    tickers,
    warning,
  }
}
