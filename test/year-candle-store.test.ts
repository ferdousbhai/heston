import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readYearCandles, upsertYearCandles } from '../src/server/year-candle-store'
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
