import { describe, expect, it, vi } from 'vitest'

import { catalystLabel, nextCatalystForSymbol, sortSymbolsByCatalyst, upcomingInterestedSymbols, type Catalyst } from '../src/domain/catalyst'
import { catalystsFromMarketMetrics, earningsDateFromMetric, persistAndLoadCatalysts } from '../src/server/catalysts'

const NOW = new Date('2026-08-13T16:00:00.000Z')

describe('tastytrade catalyst normalization', () => {
  it('stays within the D1 parameter limit when refreshing 100 symbols', async () => {
    const boundParameterCounts: number[] = []
    const batch = vi.fn(async () => [])
    const database = {
      batch,
      prepare: vi.fn(() => ({
        bind: (...values: unknown[]) => {
          boundParameterCounts.push(values.length)
          if (values.length > 100) throw new Error('too many SQL variables')
          return {
            all: async () => ({ results: [] }),
          }
        },
      })),
    } as unknown as D1Database

    const symbols = Array.from({ length: 100 }, (_, index) => `T${index}`)
    await expect(persistAndLoadCatalysts({ DB: database }, [], symbols, NOW)).resolves.toEqual([])

    expect(batch).toHaveBeenCalledOnce()
    expect(boundParameterCounts).toEqual([100, 2, 1])
  })

  it('extracts upcoming earnings and ignores dividend fields', () => {
    const catalysts = catalystsFromMarketMetrics([{
      symbol: 'NVDA',
      'updated-at': '2026-08-13T15:00:00Z',
      earnings: {
        estimated: true,
        visible: true,
        'expected-report-date': '2026-08-26',
        'time-of-day': 'After Market',
        'updated-at': '2026-08-12T20:00:00Z',
      },
      'dividend-ex-date': '2026-09-10',
      'dividend-pay-date': '2026-10-02',
      'dividend-updated-at': '2026-08-01T10:00:00Z',
    }], NOW)

    expect(catalysts).toMatchObject([
      { id: 'tastytrade:NVDA:earnings', date: '2026-08-26', timing: 'after-hours', confidence: 'estimated' },
    ])
    expect(earningsDateFromMetric({ earnings: { visible: true, 'expected-report-date': '2026-08-26' } }, NOW)).toBe('2026-08-26')
  })

  it('does not surface hidden or malformed dates', () => {
    expect(catalystsFromMarketMetrics([{
      symbol: 'AAPL',
      earnings: { visible: false, 'expected-report-date': '2026-02-31' },
    }], NOW)).toEqual([])
  })

  it('rejects a recent report date that has already passed', () => {
    expect(catalystsFromMarketMetrics([{
      symbol: 'AAPL',
      earnings: { visible: true, estimated: false, 'expected-report-date': '2026-07-30' },
    }], NOW)).toEqual([])
    expect(earningsDateFromMetric({
      earnings: { visible: true, 'expected-report-date': '2026-07-30' },
    }, NOW)).toBeNull()
  })

  it('ignores legacy dividend rows before strict D1 parsing', async () => {
    const earnings = {
      id: 'tastytrade:NVDA:earnings',
      symbol: 'NVDA',
      kind: 'earnings',
      title: 'NVDA earnings',
      date: '2026-08-26',
      timing: 'after-hours',
      confidence: 'estimated',
      source: 'tastytrade market metrics',
      sourceUrl: 'https://developer.tastytrade.com/open-api-spec/market-metrics/',
      updatedAt: NOW.toISOString(),
    }
    const database = {
      batch: vi.fn(),
      prepare: vi.fn(() => ({
        bind: () => ({
          all: async () => ({
            results: [
              { ...earnings, id: 'tastytrade:NVDA:dividend-ex', kind: 'dividend-ex' },
              earnings,
            ],
          }),
        }),
      })),
    } as unknown as D1Database

    await expect(persistAndLoadCatalysts({ DB: database }, [], [], NOW)).resolves.toEqual([earnings])
    expect(database.batch).not.toHaveBeenCalled()
  })
})

describe('catalyst ordering', () => {
  const catalyst = (symbol: string, date: string): Catalyst => ({
    id: `tastytrade:${symbol}:earnings`,
    symbol,
    kind: 'earnings',
    title: `${symbol} earnings`,
    date,
    timing: 'unknown',
    confidence: 'estimated',
    source: 'tastytrade market metrics',
    sourceUrl: 'https://developer.tastytrade.com/open-api-spec/market-metrics/',
    updatedAt: NOW.toISOString(),
  })

  it('puts the nearest upcoming catalyst first and preserves order without one', () => {
    const catalysts = [catalyst('AAPL', '2026-10-29'), catalyst('NVDA', '2026-08-26')]
    expect(sortSymbolsByCatalyst(['SPY', 'AAPL', 'TSLA', 'NVDA'], catalysts, NOW))
      .toEqual(['NVDA', 'AAPL', 'SPY', 'TSLA'])
    expect(nextCatalystForSymbol('NVDA', catalysts, NOW)?.date).toBe('2026-08-26')
    expect(catalystLabel(catalysts[1]!, NOW)).toBe('EARN 13D')
  })

  it('ignores catalysts that have passed', () => {
    expect(nextCatalystForSymbol('NVDA', [catalyst('NVDA', '2026-08-12')], NOW)).toBeUndefined()
  })

  it('ignores legacy dividend rows hydrated by an older local cache', () => {
    const legacyDividend = {
      ...catalyst('AAPL', '2026-08-15'),
      id: 'tastytrade:AAPL:dividend-ex',
      kind: 'dividend-ex',
    } as unknown as Catalyst

    expect(nextCatalystForSymbol('AAPL', [legacyDividend, catalyst('AAPL', '2026-08-20')], NOW)?.date)
      .toBe('2026-08-20')
  })

  it('builds a 30-day catalyst rail with positions before private watchlists', () => {
    const rows = [
      catalyst('AAPL', '2026-08-20'),
      catalyst('NVDA', '2026-08-26'),
      catalyst('META', '2026-08-18'),
      catalyst('TSLA', '2026-09-20'),
    ]

    expect(upcomingInterestedSymbols(
      ['NVDA', 'AAPL'],
      ['META', 'AAPL', 'TSLA', 'SPY'],
      rows,
      NOW,
    )).toEqual(['AAPL', 'NVDA', 'META'])
  })
})
