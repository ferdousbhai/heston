import { describe, expect, it, vi } from 'vitest'

import {
  catalystLabel,
  catalystSourceLink,
  hasNearTermCatalyst,
  nextCatalystsBySymbol,
  type Catalyst,
} from '../src/domain/catalyst'
import {
  catalystsFromMarketMetrics,
  earningsDateFromMetric,
  persistAndLoadCatalysts,
  persistResearchCatalysts,
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
    expect(() => catalystsFromMarketMetrics([{
      symbol: 'AAPL',
      'updated-at': '2026-08-13T15:00:00Z',
      earnings: { visible: true, 'expected-report-date': '2026-02-31' },
    }], NOW)).toThrow('invalid-earnings-date')
  })

  it('rejects malformed provider timestamps instead of substituting observation time', () => {
    expect(() => catalystsFromMarketMetrics([{
      symbol: 'AAPL',
      'updated-at': 'not-a-timestamp',
      earnings: { visible: true, 'expected-report-date': '2026-08-26' },
    }], NOW)).toThrow('invalid-updated-at')
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

describe('when a symbol is worth searching', () => {
  const catalyst = (symbol: string, date: string): Catalyst => ({
    confidence: 'estimated',
    date,
    id: `exa:${symbol}:conference:${date}`,
    kind: 'conference',
    source: 'Exa search · example.com',
    sourceUrl: 'https://example.com/events',
    symbol,
    timing: 'unknown',
    title: `${symbol} conference`,
    updatedAt: NOW.toISOString(),
  })

  it('counts only what falls inside the next month, for that symbol', () => {
    const catalysts = [catalyst('NVDA', '2026-09-05'), catalyst('BE', '2026-11-30')]

    expect(hasNearTermCatalyst('NVDA', catalysts, NOW)).toBe(true)
    // Dated, but two months out: the reader still learns nothing about the coming weeks.
    expect(hasNearTermCatalyst('BE', catalysts, NOW)).toBe(false)
    expect(hasNearTermCatalyst('TSLA', catalysts, NOW)).toBe(false)
  })

  it('ignores a date that has already passed', () => {
    expect(hasNearTermCatalyst('NVDA', [catalyst('NVDA', '2026-08-01')], NOW)).toBe(false)
  })

  it('holds the boundary day and refuses the one after it', () => {
    expect(hasNearTermCatalyst('NVDA', [catalyst('NVDA', '2026-09-12')], NOW)).toBe(true)
    expect(hasNearTermCatalyst('NVDA', [catalyst('NVDA', '2026-09-13')], NOW)).toBe(false)
  })
})

describe('what a catalyst shows a reader', () => {
  const base = {
    date: '2026-10-14',
    kind: 'conference' as const,
    symbol: 'DELL' as const,
    timing: 'intraday' as const,
    title: 'Citi 2026 Global TMT Conference',
    updatedAt: '2026-09-01T13:00:00.000Z',
  }

  it('shows the host a date was read from, never the producer that wrote the row', () => {
    // Stored labels carry provenance like "Codex web · investors.delltechnologies.com".
    // A reader checking where a date came from is looking for the site, not for ours.
    expect(catalystSourceLink({
      ...base,
      confidence: 'estimated',
      id: 'daily-research:DELL:conference:2026-10-14',
      source: 'Codex web · Dell Technologies Investor Relations',
      sourceUrl: 'https://www.investors.delltechnologies.com/events',
    })).toEqual({ host: 'investors.delltechnologies.com', url: 'https://www.investors.delltechnologies.com/events' })
  })

  it('offers no link for the broker feed, whose source is an API specification', () => {
    expect(catalystSourceLink({
      ...base,
      confidence: 'confirmed',
      id: 'tastytrade:DELL:earnings',
      kind: 'earnings',
      source: 'tastytrade market metrics',
      sourceUrl: 'https://developer.tastytrade.com/open-api-spec/market-metrics/',
    })).toBeUndefined()
  })
})

describe('research catalyst storage', () => {
  it('fails when authoritative catalyst storage is unavailable', async () => {
    await expect(persistAndLoadCatalysts({}, [], [], NOW)).rejects.toThrow('CatalystStoreUnavailable')
    await expect(persistResearchCatalysts({}, 'daily-research', [], NOW)).rejects.toThrow('CatalystStoreUnavailable')
  })

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
      id: `daily-recommendations:T${index}:2026-09-15:investor-event`,
      kind: 'investor-event',
      source: 'Example Investor Relations',
      sourceUrl: `https://example.com/events/${index}`,
      symbol: `T${index}`,
      timing: 'unknown',
      title: `T${index} investor event`,
      updatedAt: NOW.toISOString(),
    }))

    await persistResearchCatalysts({ DB: database }, 'daily-research', catalysts, NOW)

    expect(batch).toHaveBeenCalledOnce()
    expect(batchStatementCount).toBe(143)
    expect(Math.max(...boundParameterCounts)).toBe(91)
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

  it('indexes the nearest upcoming catalyst and ignores past dates', () => {
    const catalysts = [catalyst('AAPL', '2026-10-29'), catalyst('NVDA', '2026-08-26')]
    expect(nextCatalystsBySymbol(catalysts, NOW).get('NVDA')?.date).toBe('2026-08-26')
    expect(catalystLabel(catalysts[1]!, NOW)).toBe('EARN 13D')
    expect(nextCatalystsBySymbol([catalyst('NVDA', '2026-08-12')], NOW).has('NVDA')).toBe(false)
  })
})
