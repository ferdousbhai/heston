import { describe, expect, it } from 'vitest'

import {
  fiftyTwoWeekPosition,
  formatMarketMetric,
  instrumentSignals,
  MarketSnapshotSchema,
  parseStoredResearchBrief,
  volatilityVerdict,
} from '../src/domain/market'
import { marketSnapshotFixture, marketTickersFixture } from './fixtures/market'
import {
  equityCandleFromTime,
  liveTickerFromRecords,
  percentMetric,
  plausiblePercentMetric,
  plausiblePercentPoints,
  plausibleSignedPercentMetric,
  plausibleSignedPoints,
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

describe('instrument signals', () => {
  const quiet = { ...marketTickersFixture.find((ticker) => ticker.symbol === 'SPY')!, yearHigh: 900 }

  it('flags nothing for an instrument inside every band', () => {
    expect(instrumentSignals(quiet)).toEqual([])
  })

  it('names every out-of-band reading with its direction and exact supporting figures', () => {
    const signals = instrumentSignals({
      ...quiet,
      borrowRate: 12.4,
      change: -14.2,
      changePercent: -6.1,
      historicalVolatility30Day: 30,
      ivHistoricalVolatility30DayDifference: 18.2,
      ivIndex: 48.2,
      ivIndex5DayChange: -7,
      ivTermStructure: { backExpiration: '2026-09-11', backIv: 40.1, frontExpiration: '2026-09-04', frontIv: 46.7 },
      liquidity: 2,
      price: 218.7,
      yearHigh: 350,
      yearLow: 210,
    })

    expect(signals.map((signal) => [signal.key, signal.tone, signal.label, signal.detail])).toEqual([
      ['day-move', 'note', 'Down 6.1% today', '−$14.20 to $218.70'],
      ['iv-vs-hv', 'rich', 'IV 18.2 pts above realized', 'IV 48.2% · 30-day HV 30%'],
      ['iv-5-day', 'cheap', 'IV down 7 pts in 5 days', 'IV now 48.2%'],
      ['term-structure', 'note', 'Front month priced 6.6 pts over back', '2026-09-04 46.7% · 2026-09-11 40.1%'],
      ['liquidity', 'rich', 'Thin options liquidity', '2/5 tastytrade liquidity'],
      ['borrow', 'rich', 'Hard to borrow', '12.4% borrow'],
      ['range-edge', 'note', 'Near 52-week low', '6% of $210.00–$350.00'],
    ])
  })

  it('reads the opposite directions and a lendability-only borrow flag', () => {
    const signals = instrumentSignals({
      ...quiet,
      borrowRate: undefined,
      changePercent: 4,
      ivHistoricalVolatility30DayDifference: -10,
      ivIndex5DayChange: 5,
      ivTermStructure: { backExpiration: '2026-09-11', backIv: 20, frontExpiration: '2026-09-04', frontIv: 17 },
      lendability: 'Locate Required',
      price: 690,
      yearHigh: 698.44,
    })

    expect(signals.map((signal) => [signal.key, signal.tone, signal.label, signal.detail])).toEqual([
      ['day-move', 'note', 'Up 4% today', '+$3.82 to $690.00'],
      ['iv-vs-hv', 'cheap', 'IV 10 pts below realized', 'IV 14.8% · 30-day HV 12.9%'],
      ['iv-5-day', 'rich', 'IV up 5 pts in 5 days', 'IV now 14.8%'],
      ['term-structure', 'note', 'Back month priced 3 pts over front', '2026-09-04 17% · 2026-09-11 20%'],
      ['borrow', 'rich', 'Hard to borrow', 'Locate Required'],
      ['range-edge', 'note', 'Near 52-week high', '96% of $481.80–$698.44'],
    ])
  })

  it('omits volatility-gap and term-structure flags when required readings are missing', () => {
    expect(instrumentSignals({
      ...quiet,
      historicalVolatility30Day: undefined,
      ivHistoricalVolatility30DayDifference: 25,
      ivTermStructure: undefined,
    })).toEqual([])
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
    expect(percentMetric('7.5', 2_000)).toBe(750)
  })

  it('clamps required rank and percentile ratios that land just above 1.0', () => {
    expect(percentMetric('1.0004')).toBe(100)
    expect(percentMetric('-0.0001')).toBe(0)
  })

  it('reports an implausible optional metric as unavailable instead of the bound', () => {
    expect(plausiblePercentMetric('0.14', 1_000)).toBeCloseTo(14)
    expect(plausibleSignedPercentMetric('-0.02', 1_000)).toBeCloseTo(-2)
    expect(plausiblePercentMetric(undefined, 1_000)).toBeUndefined()
    expect(plausibleSignedPercentMetric(undefined, 1_000)).toBeUndefined()
    expect(plausiblePercentMetric('99', 1_000)).toBeUndefined()
    expect(plausiblePercentMetric('-0.5', 1_000)).toBeUndefined()
    expect(plausibleSignedPercentMetric('-99', 1_000)).toBeUndefined()
  })

  it('keeps point-denominated metrics as reported and treats a zero realized volatility as absent', () => {
    expect(plausiblePercentPoints('30.8', 2_000)).toBe(30.8)
    expect(plausiblePercentPoints('0', 2_000)).toBeUndefined()
    expect(plausiblePercentPoints('0', 2_000, true)).toBe(0)
    expect(plausiblePercentPoints('2001', 2_000)).toBeUndefined()
    expect(plausiblePercentPoints(undefined, 2_000)).toBeUndefined()
    expect(plausibleSignedPoints('-4.7', 2_000)).toBe(-4.7)
    expect(plausibleSignedPoints('-2001', 2_000)).toBeUndefined()
  })

  it('blanks implausible optional volatility fields without dropping the ticker', () => {
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
    expect(ticker?.historicalVolatility30Day).toBeUndefined()
    expect(ticker?.ivIndex5DayChange).toBeUndefined()
    expect(ticker?.ivHistoricalVolatility30DayDifference).toBeUndefined()
  })

  it('keeps a nonnegative annual borrow percent as reported and rejects a negative one', () => {
    function borrowRate(reported: string): number | undefined {
      return liveTickerFromRecords('BE', {
        symbol: 'BE', 'borrow-rate': reported, 'implied-volatility-index': '0.18',
        'implied-volatility-index-rank': '0.25', 'implied-volatility-percentile': '0.3',
        'liquidity-rating': '5',
      }, {
        symbol: 'BE', mark: '700', 'previous-close': '695',
        'updated-at': '2026-08-13T13:31:00.000Z',
      }, false)?.borrowRate
    }

    expect(borrowRate('-1')).toBeUndefined()
    expect(borrowRate('0')).toBe(0)
    expect(borrowRate('951.1531')).toBe(951.1531)
  })

  it('drops an implausible expiration from the term structure', () => {
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

    expect(ticker?.ivTermStructure).toBeUndefined()
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
    expect(liveTickerFromRecords('SPY', { ...metrics, 'market-cap': '0' }, quote, true)?.marketCap).toBeUndefined()
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
      'historical-volatility-30-day': '14',
      'implied-volatility-index': '0.18',
      'implied-volatility-index-5-day-change': '-0.02',
      'implied-volatility-index-rank': '0.25',
      'implied-volatility-percentile': '0.3',
      'iv-hv-30-day-difference': '4',
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
      symbol: 'SPY', description: 'SPDR S&P 500 ETF', 'borrow-rate': '0.4',
      lendability: 'Easy To Borrow', 'is-etf': true,
    })

    expect(ticker).toMatchObject({
      assetType: 'etf',
      borrowRate: 0.4,
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
  })
})
