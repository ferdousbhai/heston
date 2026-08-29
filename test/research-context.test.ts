import { describe, expect, it, vi } from 'vitest'

import { readCodexResearchContext } from '../src/server/research-codex-context'
import { collectYahooMarketMovers, type YahooMarketMoverProvider } from '../src/server/research-market-movers'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'

const NOW = new Date('2026-08-28T13:30:00.000Z')

describe('scheduled research context', () => {
  it('reads only fresh, upcoming, bounded local Codex evidence', async () => {
    const bound: unknown[][] = []
    const row = {
      id: 'codex-web:NVDA:conference:2026-09-15',
      symbol: 'NVDA',
      kind: 'conference',
      title: 'Developer conference',
      description: 'Management will discuss the next platform generation.',
      date: '2026-09-15',
      timing: 'intraday',
      confidence: 'estimated',
      source: 'Codex web · nvidia.com',
      sourceUrl: 'https://www.nvidia.com/events/developer-conference',
      updatedAt: '2026-08-10T12:00:00.000Z',
    }
    const all = async <T>() => {
      // SAFETY: this statement stands in for the one SELECT below, whose aliases define this row.
      return d1Result([row]) as D1Result<T>
    }
    const prepare = vi.fn((sql: string) => ({
      ...unsupportedStatement(),
      bind: (...values: unknown[]) => {
        bound.push(values)
        return { ...unsupportedStatement(), all }
      },
      sql,
    }))

    const result = await readCodexResearchContext({
      DB: { ...unsupportedDatabase(), prepare },
    }, NOW)

    expect(result).toMatchObject({
      catalysts: [expect.objectContaining({ symbol: 'NVDA' })],
      freshSince: '2026-08-21T13:30:00.000Z',
      status: 'available',
      truncated: false,
    })
    expect(prepare.mock.calls[0]?.[0]).toContain('last_seen_at >= ?')
    expect(bound).toEqual([[
      '2026-08-21T13:30:00.000Z',
      '2026-08-28',
      '2027-02-24',
      41,
    ]])
  })

  it('makes missing local Codex storage an explicit nonfatal state', async () => {
    await expect(readCodexResearchContext({}, NOW)).resolves.toEqual({
      errorName: 'DatabaseBindingUnavailable',
      fetchedAt: NOW.toISOString(),
      source: 'codex-web',
      status: 'unavailable',
    })
  })

  it('keeps valid Yahoo categories when another category fails', async () => {
    const observedSeconds = NOW.getTime() / 1_000
    const provider: YahooMarketMoverProvider = {
      screen: async (category) => {
        if (category === 'loser') throw new Error('Yahoo unavailable')
        return { quotes: [{
          quoteType: 'EQUITY',
          regularMarketChangePercent: category === 'gainer' ? 4.2 : 0.5,
          regularMarketPrice: 125,
          regularMarketTime: observedSeconds,
          regularMarketVolume: 2_000_000,
          symbol: category === 'gainer' ? 'NVDA' : 'AMD',
        }] }
      },
    }

    await expect(collectYahooMarketMovers(NOW, provider)).resolves.toEqual({
      fetchedAt: NOW.toISOString(),
      movers: [
        expect.objectContaining({ category: 'gainer', symbol: 'NVDA' }),
        expect.objectContaining({ category: 'most-active', symbol: 'AMD' }),
      ],
      source: 'yahoo',
      status: 'available',
      unavailableCategories: ['loser'],
    })
  })

  it('reports complete Yahoo degradation without failing required research', async () => {
    const provider: YahooMarketMoverProvider = {
      screen: async () => { throw new Error('Yahoo unavailable') },
    }

    await expect(collectYahooMarketMovers(NOW, provider)).resolves.toMatchObject({
      movers: [],
      status: 'unavailable',
      unavailableCategories: ['gainer', 'loser', 'most-active'],
    })
  })
})
