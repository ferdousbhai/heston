import { describe, expect, it } from 'vitest'

import { audienceMarketView } from '../src/data/use-audience-market'
import { marketSnapshotFixture } from './fixtures/market'

const OWNER_SNAPSHOT = marketSnapshotFixture()
const PRIVATE_TICKER = OWNER_SNAPSHOT.tickers.find((ticker) => ticker.position)
if (!PRIVATE_TICKER) throw new Error('Fixture requires an owner position')
const PUBLIC_SNAPSHOT = marketSnapshotFixture()
const publicBase = PUBLIC_SNAPSHOT.tickers[0]
if (!publicBase) throw new Error('Fixture requires a public ticker')
const PUBLIC_TICKER = { ...publicBase, position: false }

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
