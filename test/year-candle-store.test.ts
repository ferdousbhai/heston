import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  readYearAgoCloses,
  readYearCandles,
  readYearCandleSeries,
  upsertYearCandles,
} from '../src/server/year-candle-store'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const closes = [
  { time: 1_786_000_000_000, sequence: 0, close: 100 },
  { time: 1_786_086_400_000, sequence: 0, close: 104 },
]

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => store.close())

describe('year candle store', () => {
  it('replaces a symbol series whole and reports absence for one never refreshed', async () => {
    await expect(readYearCandles(store.database, ['SPY'])).resolves.toEqual(new Map())

    await upsertYearCandles(store.database, '2026-08-28', new Map([['SPY', closes]]))
    await upsertYearCandles(store.database, '2026-08-31', new Map([['SPY', closes.slice(0, 1)]]))

    await expect(readYearCandles(store.database, ['SPY', 'NVDA'])).resolves.toEqual(new Map([
      ['SPY', { asOf: '2026-08-31', closes: closes.slice(0, 1) }],
    ]))
    expect(store.sqlite.prepare('SELECT count(*) AS count FROM year_candles').get()).toEqual({ count: 1 })
  })

  it('skips an empty series and treats a poisoned row as absent rather than fatal', async () => {
    await upsertYearCandles(store.database, '2026-08-31', new Map([['SPY', []], ['NVDA', closes]]))
    await expect(readYearCandles(store.database, ['SPY'])).resolves.toEqual(new Map())

    store.sqlite.prepare("UPDATE year_candles SET closes_json = '[{\"close\":-1}]' WHERE symbol = 'NVDA'").run()
    await expect(readYearCandles(store.database, ['NVDA'])).resolves.toEqual(new Map())
  })
})

describe('year series read paths', () => {
  it('gives the snapshot an anchor without reading a year of closes for it', async () => {
    await upsertYearCandles(store.database, '2026-08-31', new Map([['SPY', closes]]))

    // The snapshot sorts and labels from this alone; the closes it would otherwise carry are
    // most of the payload and are drawn by one column on one breakpoint.
    await expect(readYearAgoCloses(store.database, ['SPY', 'NVDA']))
      .resolves.toEqual(new Map([['SPY', 100]]))
  })

  it('serves the series as bare closes, oldest first', async () => {
    await upsertYearCandles(store.database, '2026-08-31', new Map([['SPY', closes]]))

    // The chart spaces points by index, so the instants would be sent and never read; the one
    // instant that travels is the store's own refresh date, never the request's.
    await expect(readYearCandleSeries(store.database)).resolves.toEqual({ asOf: '2026-08-31', series: new Map([['SPY', [100, 104]]]) })
  })
})
