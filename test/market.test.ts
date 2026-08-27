import { describe, expect, it } from 'vitest'

import {
  fiftyTwoWeekPosition,
  formatMarketMetric,
  MarketSnapshotSchema,
  parseStoredResearchBrief,
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

  it('places the current price within a valid 52-week range', () => {
    expect(fiftyTwoWeekPosition({ price: 75, yearLow: 50, yearHigh: 100 })).toBe(50)
    expect(fiftyTwoWeekPosition({ price: 125, yearLow: 50, yearHigh: 100 })).toBe(100)
    expect(fiftyTwoWeekPosition({ price: 75, yearLow: 50 })).toBeUndefined()
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

  it('normalizes the pre-evidence D1 brief shape after an application upgrade', () => {
    const brief = parseStoredResearchBrief({
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
    })

    expect(brief.marketMovers).toEqual([])
    expect(brief.ideas).toEqual([{
      symbol: 'NVDA',
      direction: 'bullish',
      headline: 'Defined-risk call spread',
      description: 'Demand remains resilient. Horizon: 45–75 DTE.',
      risk: 'A guide-down would break the thesis.',
      play: null,
      sources: [],
    }])
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
      ['MMWATCH', 'ZZPOS'],
    )).toEqual(['AAREQ', 'ZZPOS', 'MMWATCH'])
  })

  it('normalizes tastytrade decimal ratios into percentage points', () => {
    expect(percentMetric('0.184')).toBeCloseTo(18.4)
    expect(percentMetric(undefined)).toBeUndefined()
    expect(percentMetric('1.5', 500)).toBe(150)
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
    expect(liveTickerFromRecords('SPCX', metrics, quote, false, {
      symbol: 'SPCX', description: 'SpaceX Corporation',
    })).toMatchObject({ name: 'SpaceX Corporation' })
    expect(liveTickerFromRecords('SPY', metrics, {
      symbol: 'SPY', mark: '700', prevDayClose: '695', updatedAt: '2026-08-13T13:31:00.000Z',
    }, false)?.change).toBe(5)
    expect(liveTickerFromRecords('SPY', undefined, quote, false)).toBeUndefined()
    expect(liveTickerFromRecords('SPY', metrics, { ...quote, 'updated-at': undefined }, false)).toBeUndefined()
  })

  it('normalizes optional volatility, instrument, borrow, and 52-week enrichment', () => {
    const ticker = liveTickerFromRecords('SPY', {
      symbol: 'SPY',
      'historical-volatility-30-day': '0.14',
      'implied-volatility-index': '0.18',
      'implied-volatility-index-5-day-change': '-0.02',
      'implied-volatility-index-rank': '0.25',
      'implied-volatility-percentile': '0.3',
      'iv-hv-30-day-difference': '0.04',
      'liquidity-rating': '5',
      'option-expiration-implied-volatilities': [
        { 'expiration-date': '2026-09-11T20:00:00Z', 'implied-volatility': '0.19', 'option-chain-type': 'Standard' },
        { 'expiration-date': '2026-09-04T20:00:00Z', 'implied-volatility': '0.21', 'option-chain-type': 'Standard' },
      ],
    }, {
      symbol: 'SPY', mark: '700', 'previous-close': '695',
      'updated-at': '2026-08-13T13:31:00.000Z',
      'year-high-price': '710', 'year-low-price': '480',
    }, false, {
      symbol: 'SPY', description: 'SPDR S&P 500 ETF', 'borrow-rate': '0.004',
      lendability: 'Easy To Borrow', 'is-etf': true,
    })

    expect(ticker).toMatchObject({
      assetType: 'etf',
      borrowRate: 0.4,
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
    expect(ticker?.historicalVolatility30Day).toBeCloseTo(14)
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
