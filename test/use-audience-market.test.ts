// @vitest-environment jsdom

import { QueryClient, QueryObserver } from '@tanstack/query-core'
import { describe, expect, it, vi } from 'vitest'

import {
  audienceMarketView,
  SNAPSHOT_REFETCH_MS,
  snapshotSyncQueryOptions,
} from '../src/data/use-audience-market'
import { marketSnapshotFixture } from './fixtures/market'

const OWNER_SNAPSHOT = marketSnapshotFixture()
const PRIVATE_TICKER = OWNER_SNAPSHOT.tickers[0]
if (!PRIVATE_TICKER) throw new Error('Fixture requires at least one ticker')
const PUBLIC_SNAPSHOT = marketSnapshotFixture()
const PUBLIC_TICKER = PUBLIC_SNAPSHOT.tickers[0]
if (!PUBLIC_TICKER) throw new Error('Fixture requires a public ticker')

describe('audience market projection', () => {
  it('hides live rows until the atomic snapshot matches the requested audience', () => {
    const result = audienceMarketView(
      'public',
      [{ audience: 'owner', id: 'snapshot', snapshot: OWNER_SNAPSHOT }],
      [PRIVATE_TICKER],
    )

    expect(result.snapshot).toBeUndefined()
    expect(result.tickers).toEqual([])
  })

  it('keeps the old audience hidden across a transition and reveals only the matching replacement', () => {
    const owner = audienceMarketView(
      'owner',
      [{ audience: 'owner', id: 'snapshot', snapshot: OWNER_SNAPSHOT }],
      [PRIVATE_TICKER],
    )
    expect(owner.tickers).toEqual([PRIVATE_TICKER])

    const transitioning = audienceMarketView(
      'public',
      [{ audience: 'owner', id: 'snapshot', snapshot: OWNER_SNAPSHOT }],
      [PRIVATE_TICKER],
    )
    expect(transitioning.snapshot).toBeUndefined()
    expect(transitioning.tickers).toEqual([])

    const replaced = audienceMarketView(
      'public',
      [{ audience: 'public', id: 'snapshot', snapshot: PUBLIC_SNAPSHOT }],
      [PUBLIC_TICKER],
    )
    expect(replaced.tickers).toEqual([PUBLIC_TICKER])
  })
})

describe('snapshot sync while a tab stays open', () => {
  it('refetches on the public cache lifetime, including without a focus event', async () => {
    const queryFn = vi.fn(async () => ({ ok: true }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const observer = new QueryObserver(queryClient, {
      ...snapshotSyncQueryOptions('public'),
      queryFn,
      refetchInterval: 20,
    })
    const unsubscribe = observer.subscribe()
    await vi.waitFor(() => expect(queryFn).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(queryFn.mock.calls.length).toBeGreaterThan(1))
    expect(snapshotSyncQueryOptions('public').refetchInterval()).toBe(SNAPSHOT_REFETCH_MS)
    unsubscribe()
    observer.destroy()
    queryClient.clear()
  })
})
