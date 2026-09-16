import { describe, expect, it } from 'vitest'

import { PublicMarketSnapshotSchema } from '../src/domain/market'
import { selectPublicQuoteRows } from '../src/server/public-market-tools'

describe('anonymous public quote projection', () => {
  it('reads requested rows without parsing the rest of the website book', () => {
    const snapshot = {
      syncedAt: '2026-09-16T14:07:48.941Z',
      tickers: [
        { symbol: 'AAPL', price: 236.41, change: -1.84, changePercent: -0.77, name: 'Apple' },
        { symbol: 'NVDA', price: 191.68, change: 4.91, changePercent: 2.63, ivRank: 72, ivPercentile: 81, ivIndex: 48.2, marketCap: 4_730_000_000_000 },
      ],
    }
    expect(() => PublicMarketSnapshotSchema.parse(snapshot)).toThrow()

    const projected = selectPublicQuoteRows(snapshot, ['nvda', 'XOM'])
    expect(projected.syncedAt).toBe(snapshot.syncedAt)
    expect(projected.missing).toEqual(['XOM'])
    expect(projected.rows).toEqual([{
      change: 4.91,
      changePercent: 2.63,
      ivIndex: 48.2,
      ivPercentile: 81,
      ivRank: 72,
      marketCap: 4_730_000_000_000,
      price: 191.68,
      symbol: 'NVDA',
    }])
  })

  it('fails closed on a requested row that is not a quote', () => {
    expect(() => selectPublicQuoteRows({
      syncedAt: '2026-09-16T14:07:48.941Z',
      tickers: [{ symbol: 'NVDA', price: '191.68', change: 4.91, changePercent: 2.63 }],
    }, ['NVDA'])).toThrow()
  })

  it('ignores a malformed row the caller did not ask for', () => {
    const projected = selectPublicQuoteRows({
      syncedAt: '2026-09-16T14:07:48.941Z',
      tickers: [
        { symbol: 'AAPL' },
        { symbol: 'NVDA', price: 191.68, change: 4.91, changePercent: 2.63 },
      ],
    }, ['NVDA'])
    expect(projected.rows).toHaveLength(1)
    expect(projected.rows[0]?.symbol).toBe('NVDA')
  })
})
