import { describe, expect, it, vi } from 'vitest'
import { type QuoteSummaryResult } from 'yahoo-finance2/modules/quoteSummary'

import {
  createFmpPriceHistoryProvider,
  createMarketResearchTools,
  createYahooFundamentalsProvider,
  type PriceHistoryProvider,
  type PriceHistoryRow,
  readCompanyFundamentals,
  readPriceHistory,
} from '../src/server/market-research-tools'

const now = new Date('2026-08-14T12:00:00.000Z')

function historyRows(count: number, start = '2026-07-01'): PriceHistoryRow[] {
  const first = new Date(`${start}T00:00:00.000Z`)
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(first)
    date.setUTCDate(date.getUTCDate() + index)
    return {
      adjustedClose: index + 1,
      close: (index + 1) * 10,
      date: date.toISOString().slice(0, 10),
      high: (index + 1) * 10 + 1,
      low: (index + 1) * 10 - 1,
      open: (index + 1) * 10,
      volume: 1_000 + index,
    }
  })
}

function priceProvider(
  prices: PriceHistoryRow[],
  overrides: Partial<Awaited<ReturnType<PriceHistoryProvider['readDaily']>>> = {},
) {
  return {
    readDaily: vi.fn().mockResolvedValue({
      adjustmentMethodology: 'unadjusted OHLCV plus split- and dividend-adjusted close',
      currency: 'USD',
      delay: 'end-of-day' as const,
      exchange: 'US equities EOD',
      prices,
      provider: 'test-provider',
      skippedRowCount: 0,
      sourceUrl: 'https://provider.example/history?symbol=AAPL',
      symbol: 'AAPL',
      ...overrides,
    }),
  }
}

function fundamentals(summary = 'A'.repeat(1_700)): QuoteSummaryResult {
  return {
    defaultKeyStatistics: {
      category: null,
      enterpriseToEbitda: 20,
      enterpriseToRevenue: 8,
      enterpriseValue: 4_600_000_000_000,
      forwardEps: 9.5,
      forwardPE: 31,
      fundFamily: null,
      lastSplitFactor: null,
      legalType: null,
      maxAge: 1,
      priceHint: 2,
      priceToBook: 40,
      trailingEps: 8.8,
    },
    earningsTrend: {
      defaultMethodology: 'gaap',
      maxAge: 1,
      trend: [{
        earningsEstimate: {
          avg: 9.5,
          earningsCurrency: 'USD',
          growth: 0.08,
          high: 10,
          low: 9,
          numberOfAnalysts: 30,
          yearAgoEps: 8.8,
        },
        endDate: new Date('2027-09-30T00:00:00.000Z'),
        epsRevisions: {
          downLast30days: 1,
          epsRevisionsCurrency: 'USD',
          upLast30days: 5,
        },
        epsTrend: {
          '30daysAgo': 9.4,
          '60daysAgo': 9.3,
          '7daysAgo': 9.5,
          '90daysAgo': 9.2,
          current: 9.5,
          epsTrendCurrency: 'USD',
        },
        growth: 0.08,
        maxAge: 1,
        period: '+1y',
        revenueEstimate: {
          avg: 520_000_000_000,
          growth: 0.09,
          high: 540_000_000_000,
          low: 500_000_000_000,
          numberOfAnalysts: 28,
          revenueCurrency: 'USD',
          yearAgoRevenue: 477_000_000_000,
        },
      }],
    },
    financialData: {
      currentRatio: 0.9,
      debtToEquity: 150,
      earningsGrowth: 0.1,
      financialCurrency: 'USD',
      freeCashflow: 100_000_000_000,
      grossMargins: 0.46,
      maxAge: 1,
      operatingCashflow: 120_000_000_000,
      operatingMargins: 0.32,
      profitMargins: 0.27,
      recommendationKey: 'buy',
      revenueGrowth: 0.06,
      totalCash: 60_000_000_000,
      totalDebt: 100_000_000_000,
      totalRevenue: 420_000_000_000,
    },
    majorHoldersBreakdown: {
      insidersPercentHeld: 0.02,
      institutionsCount: 7_000,
      institutionsFloatPercentHeld: 0.68,
      institutionsPercentHeld: 0.67,
      maxAge: 1,
    },
    price: {
      currency: 'USD',
      fromCurrency: null,
      lastMarket: null,
      longName: 'Apple Inc.',
      marketCap: 4_500_000_000_000,
      maxAge: 1,
      priceHint: 2,
      quoteType: 'EQUITY',
      regularMarketPrice: 300,
      regularMarketTime: new Date('2026-08-13T20:00:00.000Z'),
      shortName: 'Apple',
      symbol: 'AAPL',
      underlyingSymbol: null,
    },
    secFilings: {
      filings: Array.from({ length: 10 }, (_, index) => ({
        date: `2026-0${Math.max(1, 9 - index)}-01`,
        edgarUrl: `https://finance.yahoo.com/sec-filing/AAPL/${index}`,
        epochDate: new Date('2026-08-01T00:00:00.000Z'),
        maxAge: 1,
        title: `Filing ${index}`,
        type: index % 2 ? '8-K' as const : '10-Q' as const,
      })),
      maxAge: 1,
    },
    summaryDetail: {
      algorithm: null,
      currency: 'USD',
      fromCurrency: null,
      lastMarket: null,
      maxAge: 1,
      priceHint: 2,
      priceToSalesTrailing12Months: 10,
      tradeable: true,
      trailingPE: 34,
    },
    summaryProfile: {
      companyOfficers: [],
      country: 'United States',
      fullTimeEmployees: 150_000,
      industry: 'Consumer Electronics',
      irWebsite: 'http://investor.example.com',
      longBusinessSummary: summary,
      maxAge: 86_400,
      sector: 'Technology',
      website: 'https://www.apple.com',
    },
  }
}

describe('market research tools', () => {
  it('exposes only compact fundamentals and adjusted history capabilities', () => {
    expect(createMarketResearchTools({}).map((tool) => tool.name)).toEqual([
      'read_company_fundamentals',
      'read_price_history',
    ])
  })

  it('compacts fundamentals, omits a live quote, and labels secondary-source limitations', async () => {
    const client = {
      chart: vi.fn(),
      quoteSummary: vi.fn().mockResolvedValue(fundamentals()),
    }
    const result = await readCompanyFundamentals(' aapl ', now, createYahooFundamentalsProvider(client))

    expect(client.quoteSummary).toHaveBeenCalledWith('AAPL', expect.objectContaining({
      modules: expect.arrayContaining(['financialData', 'earningsTrend', 'secFilings']),
    }))
    expect(result).toMatchObject({
      company: {
        analystEstimates: [{ period: '+1y', epsAverage: 9.5, revenueGrowth: 0.09 }],
        filings: expect.any(Array),
        name: 'Apple Inc.',
        symbol: 'AAPL',
        valuation: { marketCapitalization: 4_500_000_000_000, trailingPriceEarnings: 34 },
      },
      fetchedAt: now.toISOString(),
      missingSections: [],
      source: 'yahoo-finance-quote-summary',
      truncated: true,
    })
    expect(result.company.filings).toHaveLength(8)
    expect(result.company.profile?.businessSummary).toHaveLength(1_601)
    expect(result.company.profile?.investorRelationsUrl).toBeUndefined()
    expect(result.warning).toContain('primary filings')
    expect(JSON.stringify(result)).not.toContain('regularMarketPrice')
  })

  it('reports present but empty response sections as missing', async () => {
    const raw = fundamentals()
    raw.earningsTrend!.trend = []
    raw.secFilings!.filings = []
    const client = { chart: vi.fn(), quoteSummary: vi.fn().mockResolvedValue(raw) }

    const result = await readCompanyFundamentals('AAPL', now, createYahooFundamentalsProvider(client))

    expect(result.missingSections).toEqual(expect.arrayContaining(['analystEstimates', 'filings']))
  })

  it('rejects mismatched fundamentals instead of returning another instrument', async () => {
    const raw = fundamentals()
    raw.price!.symbol = 'MSFT'
    const client = { chart: vi.fn(), quoteSummary: vi.fn().mockResolvedValue(raw) }
    await expect(readCompanyFundamentals(
      'AAPL',
      now,
      createYahooFundamentalsProvider(client),
    )).rejects.toThrow('mismatched')
  })

  it('translates tastytrade class-share notation only at the fundamentals provider boundary', async () => {
    const raw = fundamentals()
    raw.price!.symbol = 'BRK-B'
    const client = {
      quoteSummary: vi.fn().mockResolvedValue(raw),
    }

    const company = await readCompanyFundamentals(
      'BRK.B',
      now,
      createYahooFundamentalsProvider(client),
    )

    expect(client.quoteSummary).toHaveBeenCalledWith('BRK-B', expect.any(Object))
    expect(company.company.symbol).toBe('BRK.B')
    expect(company.sourceUrl).toContain('BRK-B')
  })

  it('returns adjusted history and aligns optional studies with the bounded row window', async () => {
    const provider = priceProvider(historyRows(30))
    const result = await readPriceHistory({
      endDate: '2026-07-30',
      interval: '1d',
      limit: 5,
      startDate: '2026-07-01',
      studies: [
        { kind: 'SMA', period: 3 },
        { kind: 'EMA', period: 3 },
        { kind: 'RSI', period: 3 },
        { kind: 'BBANDS', period: 3, standardDeviations: 2 },
        { fastPeriod: 3, kind: 'MACD', signalPeriod: 2, slowPeriod: 5 },
      ],
      symbol: 'AAPL',
    }, provider, now)

    expect(provider.readDaily).toHaveBeenCalledWith('AAPL', {
      endDate: '2026-07-30',
      startDate: '2026-07-01',
    })
    expect(result).toMatchObject({
      adjustment: 'adjusted-close',
      dataAsOf: '2026-07-30',
      delay: 'end-of-day',
      provider: 'test-provider',
      returnedRowCount: 5,
      stale: false,
      studyPriceField: 'adjustedClose',
      totalValidRowCount: 30,
      truncated: true,
    })
    expect(result.prices[0]).toMatchObject({ adjustedClose: 26, close: 260, date: '2026-07-26' })
    expect(result.studies).toHaveLength(5)
    expect(result.studies[0]).toMatchObject({ kind: 'SMA' })
    expect(result.studies[0]!.points[0]).toMatchObject({ date: '2026-07-26', value: 25 })
    expect(result.studies[2]).toMatchObject({ kind: 'RSI' })
    expect(result.studies[2]!.points[0]).toMatchObject({ value: 100 })
    expect(result.studies[4]).toMatchObject({ kind: 'MACD' })
    expect(result.studies[4]!.points[0]).toMatchObject({
      histogram: expect.any(Number),
      macd: expect.any(Number),
      signal: expect.any(Number),
    })
    for (const study of result.studies) expect(study.points).toHaveLength(5)
  })

  it('defaults the inclusive range to the New York market date', async () => {
    const provider = priceProvider(historyRows(1, '2026-08-14'))

    const result = await readPriceHistory(
      { symbol: 'AAPL' },
      provider,
      new Date('2026-08-15T01:00:00.000Z'),
    )

    expect(result.requestedRange.endDate).toBe('2026-08-14')
    expect(provider.readDaily).toHaveBeenCalledWith('AAPL', expect.objectContaining({
      endDate: '2026-08-14',
    }))
  })

  it('fails before fetching on invalid ranges and duplicate or invalid studies', async () => {
    const provider = priceProvider(historyRows(1))
    await expect(readPriceHistory({
      endDate: '2026-02-31',
      symbol: 'AAPL',
    }, provider, now)).rejects.toThrow('end date')
    await expect(readPriceHistory({
      endDate: '2026-01-01',
      startDate: '2026-01-02',
      symbol: 'AAPL',
    }, provider, now)).rejects.toThrow('range')
    await expect(readPriceHistory({
      studies: [{ kind: 'SMA' }, { kind: 'SMA' }],
      symbol: 'AAPL',
    }, provider, now)).rejects.toThrow('Duplicate')
    await expect(readPriceHistory({
      studies: [{ fastPeriod: 26, kind: 'MACD', slowPeriod: 12 }],
      symbol: 'AAPL',
    }, provider, now)).rejects.toThrow('fast period')
    expect(provider.readDaily).not.toHaveBeenCalled()
  })

  it('aggregates weekly and monthly bars locally without changing adjusted-close semantics', async () => {
    const rows = historyRows(10, '2026-07-27')
    const weekly = await readPriceHistory(
      { interval: '1wk', symbol: 'AAPL' },
      priceProvider(rows),
      now,
    )
    const monthly = await readPriceHistory(
      { interval: '1mo', symbol: 'AAPL' },
      priceProvider(rows),
      now,
    )

    expect(weekly.prices).toHaveLength(2)
    expect(weekly.prices[0]).toMatchObject({
      adjustedClose: 7,
      close: 70,
      date: '2026-08-02',
      high: 71,
      low: 9,
      open: 10,
    })
    expect(monthly.prices).toHaveLength(2)
    expect(monthly.prices[0]).toMatchObject({ adjustedClose: 5, date: '2026-07-31' })
    expect(monthly.prices[1]).toMatchObject({ adjustedClose: 10, date: '2026-08-05' })
  })

  it('merges FMP unadjusted and dividend-adjusted rows by exact symbol and date', async () => {
    const client = {
      get: vi.fn()
        .mockResolvedValueOnce([
          { symbol: 'AAPL', date: '2026-08-14', open: 101, high: 103, low: 100, close: 102, volume: 2_000 },
          { symbol: 'AAPL', date: '2026-08-13', open: 99, high: 102, low: 98, close: 101, volume: 1_000 },
          { symbol: 'AAPL', date: '2026-08-12', open: null, high: 100, low: 98, close: 99, volume: 900 },
        ])
        .mockResolvedValueOnce([
          { symbol: 'AAPL', date: '2026-08-14', adjOpen: 100, adjHigh: 102, adjLow: 99, adjClose: 101, volume: 2_000 },
          { symbol: 'AAPL', date: '2026-08-13', adjOpen: 98, adjHigh: 101, adjLow: 97, adjClose: 100, volume: 1_000 },
        ]),
    }
    const provider = createFmpPriceHistoryProvider({}, client)

    const result = await provider.readDaily('AAPL', {
      endDate: '2026-08-14',
      startDate: '2026-08-12',
    })

    expect(client.get).toHaveBeenNthCalledWith(1, '/historical-price-eod/non-split-adjusted', {
      from: '2026-08-12', symbol: 'AAPL', to: '2026-08-14',
    })
    expect(client.get).toHaveBeenNthCalledWith(2, '/historical-price-eod/dividend-adjusted', {
      from: '2026-08-12', symbol: 'AAPL', to: '2026-08-14',
    })
    expect(result).toMatchObject({
      provider: 'financial-modeling-prep',
      skippedRowCount: 1,
      symbol: 'AAPL',
    })
    expect(result.prices).toEqual([
      { adjustedClose: 100, close: 101, date: '2026-08-13', high: 102, low: 98, open: 99, volume: 1_000 },
      { adjustedClose: 101, close: 102, date: '2026-08-14', high: 103, low: 100, open: 101, volume: 2_000 },
    ])
    expect(result.sourceUrl).not.toContain('apikey')
  })

  it('rejects duplicate FMP dates and cross-symbol provider responses', async () => {
    const complete = { symbol: 'AAPL', date: '2026-08-14', open: 10, high: 11, low: 9, close: 10, volume: 1_000 }
    const adjusted = { symbol: 'AAPL', date: '2026-08-14', adjClose: 10 }
    const duplicates = createFmpPriceHistoryProvider({}, {
      get: vi.fn().mockResolvedValueOnce([complete, complete]).mockResolvedValueOnce([adjusted]),
    })
    const mismatch = createFmpPriceHistoryProvider({}, {
      get: vi.fn()
        .mockResolvedValueOnce([{ ...complete, symbol: 'MSFT' }])
        .mockResolvedValueOnce([{ ...adjusted, symbol: 'MSFT' }]),
    })
    const range = { endDate: '2026-08-14', startDate: '2026-08-14' }

    await expect(duplicates.readDaily('AAPL', range)).rejects.toThrow('invalid-response')
    await expect(mismatch.readDaily('AAPL', range)).rejects.toThrow('invalid-response')
  })
})
