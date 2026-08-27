import { describe, expect, it, vi } from 'vitest'

import { catalystLabel, nextCatalystForSymbol, sortSymbolsByCatalyst, upcomingCatalystSymbols, type Catalyst } from '../src/domain/catalyst'
import {
  catalystsFromMarketMetrics,
  earningsDateFromMetric,
  persistAndLoadCatalysts,
  persistResearchedCatalysts,
} from '../src/server/catalysts'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'

const NOW = new Date('2026-08-13T16:00:00.000Z')

describe('tastytrade catalyst normalization', () => {
  it('stays within the D1 parameter limit when refreshing 100 symbols', async () => {
    const boundParameterCounts: number[] = []
    const batch = vi.fn(async () => [])
    const database: D1Database = {
      ...unsupportedDatabase(),
      batch,
      prepare: vi.fn(() => ({
        ...unsupportedStatement(),
        bind: (...values: unknown[]) => {
          boundParameterCounts.push(values.length)
          if (values.length > 100) throw new Error('too many SQL variables')
          return {
            ...unsupportedStatement(),
            all: async () => d1Result([]),
          }
        },
      })),
    }

    const symbols = Array.from({ length: 100 }, (_, index) => `T${index}`)
    await expect(persistAndLoadCatalysts({ DB: database }, [], symbols, NOW)).resolves.toEqual([])

    expect(batch).toHaveBeenCalledOnce()
    expect(boundParameterCounts).toEqual([100, 1])
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

})

describe('research catalyst storage', () => {
  it('keeps the maximum accepted bootstrap below D1 query and bind limits', async () => {
    const boundParameterCounts: number[] = []
    let batchStatementCount = 0
    const batch = vi.fn(async (statements: D1PreparedStatement[]) => {
      batchStatementCount = statements.length
      return []
    })
    const database: D1Database = {
      ...unsupportedDatabase(),
      batch,
      prepare: vi.fn(() => ({
        ...unsupportedStatement(),
        bind: (...values: unknown[]) => {
          boundParameterCounts.push(values.length)
          if (values.length > 100) throw new Error('too many SQL variables')
          return unsupportedStatement()
        },
      })),
    }
    const catalysts: Catalyst[] = Array.from({ length: 1_000 }, (_, index) => ({
      confidence: 'estimated',
      date: '2026-09-15',
      id: `codex-web:T${index}:2026-09-15:investor-event`,
      kind: 'investor-event',
      source: 'Example Investor Relations',
      sourceUrl: `https://example.com/events/${index}`,
      symbol: `T${index}`,
      timing: 'unknown',
      title: `T${index} investor event`,
      updatedAt: NOW.toISOString(),
    }))

    await persistResearchedCatalysts({ DB: database }, 'codex-web', catalysts, NOW)

    expect(batch).toHaveBeenCalledOnce()
    expect(batchStatementCount).toBe(125)
    expect(Math.max(...boundParameterCounts)).toBe(96)
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

  it('builds a source-neutral 30-day catalyst rail with deterministic ordering and deduplication', () => {
    const rows = [
      catalyst('AAPL', '2026-08-20'),
      catalyst('NVDA', '2026-08-26'),
      catalyst('META', '2026-08-18'),
      catalyst('TSLA', '2026-09-20'),
    ]

    expect(upcomingCatalystSymbols(
      ['NVDA', 'AAPL', 'META', 'AAPL', 'TSLA', 'SPY'],
      rows,
      NOW,
    )).toEqual(['META', 'AAPL', 'NVDA'])
  })
})
