import { describe, expect, it } from 'vitest'

import {
  aggregatePrivateWatchlists,
  formatMarketMetric,
  MarketSnapshotSchema,
  volatilityVerdict,
} from '../src/domain/market'
import { marketSnapshotFixture } from './fixtures/market'
import {
  equityCandleFromTime,
  liveTickerFromRecords,
  percentMetric,
  selectSnapshotSymbols,
} from '../src/server/tastytrade'

describe('volatility classification', () => {
  it('formats market metrics with at most one decimal place', () => {
    expect(formatMarketMetric(26.9097222)).toBe('26.9')
    expect(formatMarketMetric(72)).toBe('72')
  })

  it('treats low rank and percentile as cheap', () => {
    expect(volatilityVerdict({ ivRank: 22, ivPercentile: 27 })).toBe('cheap')
  })

  it('treats high rank or percentile as rich', () => {
    expect(volatilityVerdict({ ivRank: 75, ivPercentile: 60 })).toBe('rich')
    expect(volatilityVerdict({ ivRank: 50, ivPercentile: 82 })).toBe('rich')
  })
})

describe('snapshot contract', () => {
  it('validates a complete tastytrade snapshot', () => {
    expect(MarketSnapshotSchema.parse(marketSnapshotFixture()).tickers.length).toBeGreaterThan(3)
  })

  it('returns isolated fixtures for tests that mutate broker state', () => {
    const snapshot = marketSnapshotFixture()
    snapshot.watchlists[0]!.symbols.push('MUTATED')

    expect(marketSnapshotFixture().watchlists[0]!.symbols).not.toContain('MUTATED')
  })

  it('collapses every private list into one deduplicated Watchlist', () => {
    expect(aggregatePrivateWatchlists([
      { id: 'one', kind: 'private', name: 'Core', symbols: ['SPY', 'NVDA'] },
      { id: 'two', kind: 'private', name: 'Ideas', symbols: ['NVDA', 'META'] },
      { id: 'public', kind: 'public', name: 'Public', symbols: ['AAPL'] },
    ])).toEqual({
      id: 'watchlist', kind: 'private', name: 'Watchlist', symbols: ['SPY', 'NVDA', 'META'],
    })
  })
})

describe('tastytrade normalization', () => {
  it('keeps active positions and explicitly requested symbols inside the snapshot bound', () => {
    const privateSymbols = Array.from({ length: 100 }, (_, index) => `P${index}`)
    expect(selectSnapshotSymbols(
      ['ACTIVE'],
      ['REQUEST'],
      [{ id: 'private', kind: 'private', name: 'Private', symbols: privateSymbols }],
      [{ id: 'public', kind: 'public', name: 'Public', symbols: ['PUBLIC'] }],
    ).slice(0, 3)).toEqual(['ACTIVE', 'REQUEST', 'P0'])
  })

  it('normalizes tastytrade decimal ratios into percentage points', () => {
    expect(percentMetric('0.184')).toBeCloseTo(18.4)
    expect(percentMetric(undefined)).toBeUndefined()
    expect(percentMetric('1.5', 500)).toBe(150)
  })

  it('rejects incomplete live ticker facts instead of filling estimates', () => {
    const quote = {
      symbol: 'SPY', mark: '700', 'previous-close': '695',
      'updated-at': '2026-08-13T13:31:00.000Z',
    }
    const metrics = {
      symbol: 'SPY', 'implied-volatility-index': '0.18',
      'implied-volatility-index-rank': '0.25', 'implied-volatility-percentile': '0.3',
      'liquidity-rating': '5',
    }
    expect(liveTickerFromRecords('SPY', metrics, quote, true)).toMatchObject({
      symbol: 'SPY', price: 700, ivIndex: 18, ivRank: 25, ivPercentile: 30,
      position: true, updatedAt: '2026-08-13T13:31:00.000Z',
    })
    expect(liveTickerFromRecords('SPY', metrics, {
      symbol: 'SPY', mark: '700', prevDayClose: '695', updatedAt: '2026-08-13T13:31:00.000Z',
    }, false)?.change).toBe(5)
    expect(liveTickerFromRecords('SPY', undefined, quote, false)).toBeUndefined()
    expect(liveTickerFromRecords('SPY', metrics, { ...quote, 'updated-at': undefined }, false)).toBeUndefined()
  })

  it('starts candle history at the current or most recent equity session open', () => {
    const now = Date.parse('2026-08-13T14:00:00.000Z')
    expect(equityCandleFromTime({
      data: {
        'open-at': '2026-08-13T13:30:00.000Z',
        'previous-session': { 'open-at': '2026-08-12T13:30:00.000Z' },
      },
    }, now)).toBe(Date.parse('2026-08-13T13:30:00.000Z'))
    expect(equityCandleFromTime({
      data: {
        'open-at': '2026-08-14T13:30:00.000Z',
        'previous-session': { 'open-at': '2026-08-13T13:30:00.000Z' },
      },
    }, now)).toBe(Date.parse('2026-08-13T13:30:00.000Z'))
    expect(equityCandleFromTime({
      data: {
        state: 'PreMarket',
        'open-at': '2026-08-13T14:30:00.000Z',
        'previous-session': { 'open-at': '2026-08-12T13:30:00.000Z' },
      },
    }, now)).toBe(Date.parse('2026-08-12T13:30:00.000Z'))
  })
})
