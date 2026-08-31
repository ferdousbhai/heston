import { describe, expect, it } from 'vitest'

import {
  fiftyTwoWeekPosition,
  formatMarketMetric,
  issuerName,
  MarketSnapshotSchema,
  marketSnapshotFromPublic,
  parseStoredResearchBrief,
  PublicMarketSnapshotSchema,
  volatilityVerdict,
} from '../src/domain/market'
import { marketSnapshotFixture } from './fixtures/market'
import {
  equityCandleFromTime,
  liveTickerFromRecords,
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

  it('keeps missing premium observations explicit', () => {
    expect(volatilityVerdict({ ivRank: undefined, ivPercentile: 82 })).toBe('unavailable')
  })

  it('displays the issuer without the security class the provider appends', () => {
    expect(issuerName('NVIDIA Corporation - Common Stock')).toBe('NVIDIA Corporation')
    expect(issuerName('Dell Technologies Inc. Class C')).toBe('Dell Technologies Inc. Class C')
  })

  it('places the current price within a valid 52-week range', () => {
    expect(fiftyTwoWeekPosition({ price: 75, yearLow: 50, yearHigh: 100 })).toBe(50)
    expect(fiftyTwoWeekPosition({ price: 125, yearLow: 50, yearHigh: 100 })).toBe(100)
    expect(fiftyTwoWeekPosition({ price: 75, yearLow: 50 })).toBeUndefined()
  })
})

describe('snapshot contract', () => {
  it('validates a complete tastytrade snapshot', () => {
    expect(MarketSnapshotSchema.parse(marketSnapshotFixture()).tickers.length).toBeGreaterThan(3)
    expect(() => MarketSnapshotSchema.parse({ ...marketSnapshotFixture(), watchlists: [] })).toThrow()
  })

  it('keeps position membership impossible on the public wire and restores the browser default', () => {
    const owner = marketSnapshotFixture()
    const publicValue = {
      ...owner,
      watchlists: [{ ...owner.watchlists[0]!, kind: 'public' as const }],
      tickers: owner.tickers.map(({ position: _position, ...ticker }) => ticker),
    }

    expect(PublicMarketSnapshotSchema.parse(publicValue).tickers[0]).not.toHaveProperty('position')
    expect(() => PublicMarketSnapshotSchema.parse({
      ...publicValue,
      tickers: [{ ...publicValue.tickers[0], position: true }],
    })).toThrow()
    expect(marketSnapshotFromPublic(publicValue).tickers.every((ticker) => ticker.position === false)).toBe(true)
  })

  it('returns isolated fixtures for tests that mutate broker state', () => {
    const snapshot = marketSnapshotFixture()
    snapshot.watchlists[0]!.symbols.push('MUTATED')

    expect(marketSnapshotFixture().watchlists[0]!.symbols).not.toContain('MUTATED')
  })

  it('rejects the pre-evidence D1 brief shape instead of manufacturing current output', () => {
    const legacy = {
      id: 'brief-2026-08-12',
      publishedAt: '2026-08-12T13:35:00.000Z',
      title: 'Legacy daily brief',
      summary: 'A stored brief from the earlier research contract.',
      regime: 'Selective',
      regimeDetail: 'Defined risk',
      ideas: [{
        symbol: 'NVDA',
        direction: 'bullish',
        setup: 'Defined-risk call spread',
        thesis: 'Demand remains resilient.',
        risk: 'A guide-down would break the thesis.',
        horizon: '45–75 DTE',
      }],
      sources: [{ label: 'tastytrade market metrics', url: 'https://example.com/metrics' }],
    }

    expect(() => parseStoredResearchBrief(legacy)).toThrow()
  })

  it('rejects non-HTTPS links in historical briefs before they reach anchor elements', () => {
    const legacy = {
      ...marketSnapshotFixture().research,
      sources: [{ label: 'Untrusted legacy source', url: 'javascript:alert(1)' }],
    }

    expect(() => parseStoredResearchBrief(legacy)).toThrow(/HTTPS source URL/)
  })

})

describe('tastytrade normalization', () => {
  it('keeps requested symbols and positions ahead of the bounded internal focus', () => {
    expect(selectSnapshotSymbols(
      ['ZZPOS'],
      ['AAREQ'],
      ['MMWATC', 'ZZPOS'],
    )).toEqual(['AAREQ', 'ZZPOS', 'MMWATC'])
  })

  it('rejects a snapshot symbol overflow instead of slicing it', () => {
    const symbols = Array.from({ length: 101 }, (_, index) => `A${index.toString(36).toUpperCase()}`)
    expect(() => selectSnapshotSymbols([], symbols, [])).toThrow('too-many-symbols')
  })

  it('preserves present optional volatility observations without plausibility caps', () => {
    const ticker = liveTickerFromRecords('BE', {
      symbol: 'BE',
      'historical-volatility-30-day': '0',
      'implied-volatility-index': '0.18',
      'implied-volatility-index-5-day-change': '-99',
      'implied-volatility-index-rank': '0.25',
      'implied-volatility-percentile': '0.3',
      'iv-hv-30-day-difference': '2001',
      'liquidity-rating': '5',
    }, {
      symbol: 'BE', mark: '700', 'previous-close': '695',
      'updated-at': '2026-08-13T13:31:00.000Z',
    }, false)

    expect(ticker).toMatchObject({ symbol: 'BE', ivRank: 25 })
    expect(ticker.historicalVolatility30Day).toBe(0)
    expect(ticker.ivIndex5DayChange).toBe(-9_900)
    expect(ticker.ivHistoricalVolatility30DayDifference).toBe(2_001)
  })

  it('keeps the provider term observation without an arbitrary volatility ceiling', () => {
    const ticker = liveTickerFromRecords('BE', {
      symbol: 'BE', 'implied-volatility-index': '0.18',
      'implied-volatility-index-rank': '0.25', 'implied-volatility-percentile': '0.3',
      'liquidity-rating': '5',
      'option-expiration-implied-volatilities': [
        { 'expiration-date': '2026-09-04T20:00:00Z', 'implied-volatility': '0.21', 'option-chain-type': 'Standard' },
        { 'expiration-date': '2026-09-11T20:00:00Z', 'implied-volatility': '99', 'option-chain-type': 'Standard' },
      ],
    }, {
      symbol: 'BE', mark: '700', 'previous-close': '695',
      'updated-at': '2026-08-13T13:31:00.000Z',
    }, false)

    expect(ticker.ivTermStructure?.backIv).toBe(9_900)
  })

  it('rejects incomplete live ticker facts instead of filling estimates', () => {
    const quote = {
      symbol: 'SPY', mark: '700', 'previous-close': '695',
      volume: '12345678',
      'updated-at': '2026-08-13T13:31:00.000Z',
    }
    const metrics = {
      symbol: 'SPY', 'implied-volatility-index': '0.18',
      'implied-volatility-index-rank': '0.25', 'implied-volatility-percentile': '0.3',
      'liquidity-rating': '5', 'market-cap': '900000000000',
    }
    expect(liveTickerFromRecords('SPY', metrics, quote, true)).toMatchObject({
      symbol: 'SPY', price: 700, ivIndex: 18, ivRank: 25, ivPercentile: 30,
      marketCap: 900_000_000_000, volume: 12_345_678,
      position: true, updatedAt: '2026-08-13T13:31:00.000Z',
    })
    expect(liveTickerFromRecords('SPY', metrics, quote, true).sparkline).toEqual([])
    expect(liveTickerFromRecords('SPY', { ...metrics, 'market-cap': '0' }, quote, true).marketCap).toBe(0)
    expect(liveTickerFromRecords('SPCX', metrics, quote, false, {
      symbol: 'SPCX', description: 'SpaceX Corporation',
    })).toMatchObject({ assetType: undefined, name: 'SpaceX Corporation' })
    expect(liveTickerFromRecords('SPCX', metrics, quote, false, {
      symbol: 'SPCX', description: 'SpaceX Corporation', 'is-etf': false, 'is-index': false,
    }).assetType).toBe('stock')
    expect(liveTickerFromRecords('SPY', metrics, {
      symbol: 'SPY', mark: '700', prevDayClose: '695',
      updatedAt: '2026-08-13T13:31:00.000Z',
    }, false).change).toBe(5)
    expect(() => liveTickerFromRecords('SPY', undefined, quote, false)).toThrow('missing-metrics')
    expect(() => liveTickerFromRecords('SPY', metrics, { ...quote, 'updated-at': undefined }, false))
      .toThrow('invalid-updated-at')
    const projected = liveTickerFromRecords('SPY', metrics, quote, false)
    expect(projected.change).toBe(5)
    expect(projected.changePercent).toBeCloseTo(0.7194244604)
    expect(liveTickerFromRecords('SPY', {
      symbol: 'SPY',
      'implied-volatility-index': null,
      'implied-volatility-percentile': null,
      'implied-volatility-rank': null,
      'liquidity-rating': null,
    }, quote, false)).toMatchObject({
      ivIndex: undefined,
      ivPercentile: undefined,
      ivRank: undefined,
      liquidity: undefined,
    })
    expect(() => liveTickerFromRecords('SPY', metrics, { ...quote, volume: 'many' }, false))
      .toThrow('invalid-volume')
  })

  it('normalizes optional volatility, instrument, borrow, and 52-week enrichment', () => {
    const ticker = liveTickerFromRecords('SPY', {
      symbol: 'SPY',
      'historical-volatility-30-day': '14',
      'implied-volatility-index': '0.18',
      'implied-volatility-index-5-day-change': '-0.02',
      'implied-volatility-index-rank': '0.25',
      'implied-volatility-percentile': '0.3',
      'iv-hv-30-day-difference': '4',
      'liquidity-rating': '5',
      'option-expiration-implied-volatilities': [
        { 'expiration-date': null, 'implied-volatility': null },
        { 'expiration-date': '2026-09-11T20:00:00Z', 'implied-volatility': '0.19', 'option-chain-type': 'Standard' },
        { 'expiration-date': '2026-09-04T20:00:00Z', 'implied-volatility': '0.21', 'option-chain-type': 'Standard' },
      ],
    }, {
      symbol: 'SPY', mark: '700', 'previous-close': '695',
      'updated-at': '2026-08-13T13:31:00.000Z',
      'year-high-price': '710', 'year-low-price': '480',
    }, false, {
      symbol: 'SPY', description: 'SPDR S&P 500 ETF',
      lendability: 'Easy To Borrow', 'is-etf': true,
    })

    expect(ticker).toMatchObject({
      assetType: 'etf',
      historicalVolatility30Day: 14,
      ivHistoricalVolatility30DayDifference: 4,
      ivIndex5DayChange: -2,
      ivTermStructure: {
        frontExpiration: '2026-09-04', frontIv: 21,
        backExpiration: '2026-09-11', backIv: 19,
      },
      lendability: 'Easy To Borrow',
      name: 'SPDR S&P 500 ETF',
      yearHigh: 710,
      yearLow: 480,
    })
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
    expect(equityCandleFromTime({
      data: {
        state: 'Closed',
        'previous-session': { 'open-at': '2026-08-12T13:30:00.000Z' },
      },
    }, now)).toBe(Date.parse('2026-08-12T13:30:00.000Z'))
    expect(() => equityCandleFromTime({
      data: {
        'open-at': 'not-a-date',
        'previous-session': { 'open-at': '2026-08-12T13:30:00.000Z' },
      },
    }, now)).toThrow('invalid-current-open')
    expect(() => equityCandleFromTime({ data: { state: 'Closed' } }, now))
      .toThrow('invalid-previous-session')
    expect(() => equityCandleFromTime({
      data: { 'open-at': '2026-08-14T13:30:00.000Z', 'previous-session': {} },
    }, now)).toThrow('no-open-session')
  })
})
