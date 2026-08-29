import { describe, expect, it, vi } from 'vitest'
import { type ChartResultArray } from 'yahoo-finance2/modules/chart'

import { type JsonObject } from '../src/domain/json-payload'

import {
  createMarketResearchTools,
  createYahooPriceHistoryProvider,
  type PriceHistoryProvider,
  type PriceHistoryRow,
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

function chartDate(date: string): Date {
  return new Date(`${date}T13:30:00.000Z`)
}

function chartClient(quotes: ChartResultArray['quotes'], meta: JsonObject = {}) {
  return {
    chart: vi.fn().mockResolvedValue({
      meta: { currency: 'USD', exchangeName: 'NMS', symbol: 'AAPL', ...meta },
      quotes,
    }),
  }
}

describe('market research tools', () => {
  it('exposes adjusted price history while public fundamentals use native web search', () => {
    expect(createMarketResearchTools().map((tool) => tool.name)).toEqual([
      'read_price_history',
    ])
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

  it('leaves calendar range breadth to the bounded provider-row envelope', async () => {
    const provider = priceProvider(historyRows(1))

    await expect(readPriceHistory({
      endDate: '2026-07-30',
      startDate: '2000-01-01',
      symbol: 'AAPL',
    }, provider, now)).resolves.toMatchObject({ prices: [expect.any(Object)] })
    expect(provider.readDaily).toHaveBeenCalledWith('AAPL', {
      endDate: '2026-07-30',
      startDate: '2000-01-01',
    })
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

  it('allows study parameters up to the accepted provider allocation boundary', async () => {
    await expect(readPriceHistory({
      studies: [{ kind: 'SMA', period: 201 }, { kind: 'BBANDS', standardDeviations: 5.1 }],
      symbol: 'AAPL',
    }, priceProvider(historyRows(1)), now)).resolves.toMatchObject({
      studies: [{ kind: 'SMA', period: 201 }, { kind: 'BBANDS', standardDeviations: 5.1 }],
    })
    await expect(readPriceHistory({
      studies: [{ kind: 'SMA', period: 4_001 }],
      symbol: 'AAPL',
    }, priceProvider(historyRows(1)), now)).rejects.toThrow('SMA period')
    await expect(readPriceHistory({
      studies: [{ kind: 'BBANDS', period: 2, standardDeviations: Number.MAX_VALUE }],
      symbol: 'AAPL',
    }, priceProvider(historyRows(2).map((row, index) => ({
      ...row,
      adjustedClose: index === 0 ? 1 : 5,
    }))), now)).rejects.toThrow('non-finite result')
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

  it('normalizes Yahoo chart bars to ascending adjusted rows and skips incomplete ones', async () => {
    const client = chartClient([
      { adjclose: 101, close: 102, date: chartDate('2026-08-14'), high: 103, low: 100, open: 101, volume: 2_000 },
      { adjclose: 100, close: 101, date: chartDate('2026-08-13'), high: 102, low: 98, open: 99, volume: 1_000 },
      { adjclose: 98, close: 99, date: chartDate('2026-08-12'), high: 100, low: 98, open: null, volume: 900 },
    ], { longName: 'Apple Inc.' })
    const provider = createYahooPriceHistoryProvider(client)

    const result = await provider.readDaily('AAPL', { endDate: '2026-08-14', startDate: '2026-08-12' })

    expect(client.chart).toHaveBeenCalledWith('AAPL', {
      interval: '1d',
      period1: '2026-08-12',
      period2: '2026-08-15',
    })
    expect(result).toMatchObject({
      currency: 'USD',
      exchange: 'NMS',
      name: 'Apple Inc.',
      provider: 'yahoo-finance-chart',
      skippedRowCount: 1,
      symbol: 'AAPL',
    })
    expect(result.prices).toEqual([
      { adjustedClose: 100, close: 101, date: '2026-08-13', high: 102, low: 98, open: 99, volume: 1_000 },
      { adjustedClose: 101, close: 102, date: '2026-08-14', high: 103, low: 100, open: 101, volume: 2_000 },
    ])
  })

  it('rejects Yahoo history when required adjusted close or market metadata is absent', async () => {
    const provider = createYahooPriceHistoryProvider(chartClient([
      { close: 10, date: chartDate('2026-08-14'), high: 11, low: 9, open: 10, volume: 1_000 },
    ]))
    const missingCurrency = createYahooPriceHistoryProvider(chartClient([
      { adjclose: 10, close: 10, date: chartDate('2026-08-14'), high: 11, low: 9, open: 10, volume: 1_000 },
    ], { currency: undefined }))
    const range = { endDate: '2026-08-14', startDate: '2026-08-14' }

    await expect(provider.readDaily('AAPL', range)).rejects.toThrow('invalid-response')
    await expect(missingCurrency.readDaily('AAPL', range)).rejects.toThrow('invalid-response')
  })

  it('rejects duplicate dates, cross-symbol responses, and empty Yahoo history', async () => {
    const bar = { adjclose: 10, close: 10, date: chartDate('2026-08-14'), high: 11, low: 9, open: 10, volume: 1_000 }
    const range = { endDate: '2026-08-14', startDate: '2026-08-14' }
    const duplicates = createYahooPriceHistoryProvider(chartClient([bar, { ...bar }]))
    const mismatch = createYahooPriceHistoryProvider(chartClient([bar], { symbol: 'MSFT' }))
    const empty = createYahooPriceHistoryProvider(chartClient([]))

    await expect(duplicates.readDaily('AAPL', range)).rejects.toThrow('invalid-response')
    await expect(mismatch.readDaily('AAPL', range)).rejects.toThrow('invalid-response')
    await expect(empty.readDaily('AAPL', range)).rejects.toThrow('invalid-response')
  })

  it('translates class-share notation and reports provider failure as unavailable', async () => {
    const failing = {
      chart: vi.fn().mockRejectedValue(new Error('network down')),
    }

    await expect(createYahooPriceHistoryProvider(failing).readDaily('BRK/B', {
      endDate: '2026-08-14',
      startDate: '2026-08-14',
    })).rejects.toThrow('ResearchProvider:yahoo:unavailable')
    expect(failing.chart).toHaveBeenCalledWith('BRK-B', expect.any(Object))
  })
})
