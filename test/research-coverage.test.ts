import { describe, expect, it, vi } from 'vitest'

import { searchRecentTickerCoverage } from '../src/server/research-coverage'
import { unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { sqliteD1 } from './sqlite-d1'

describe('recent ticker coverage search', () => {
  it('keeps all requested coverage in the model-selected lookback', async () => {
    const results = Array.from({ length: 4 }, (_, index) => ({
      description: `Current description ${index}`,
      direction: 'bullish',
      headline: `Current headline ${index}`,
      published_at: `2026-08-${String(26 - index).padStart(2, '0')}T13:30:00.000Z`,
      risk: `Current risk ${index}`,
      symbol: 'NVDA',
    }))
    const all = vi.fn().mockResolvedValue({ results })
    const bind = vi.fn(() => ({ ...unsupportedStatement(), all }))
    const prepare = vi.fn(() => ({ ...unsupportedStatement(), bind }))
    const DB: D1Database = { ...unsupportedDatabase(), prepare }
    const now = new Date('2026-08-27T13:30:00.000Z')

    const coverage = await searchRecentTickerCoverage({ DB }, ['NVDA', 'NVDA', 'META'], 14, now)

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining(
      "IN (SELECT value FROM json_each(?))",
    ))
    expect(bind).toHaveBeenCalledWith(
      '2026-08-13T13:30:00.000Z',
      '2026-08-27T13:30:00.000Z',
      'brief-2026-08-27',
      '["NVDA","META"]',
    )
    expect(coverage.filter((item) => item.symbol === 'NVDA')).toHaveLength(4)
    expect(coverage).toHaveLength(4)
  })

  it('excludes the current market date so a rerun does not read its own brief as coverage', async () => {
    const all = vi.fn().mockResolvedValue({ results: [] })
    const bind = vi.fn(() => ({ ...unsupportedStatement(), all }))
    const prepare = vi.fn(() => ({ ...unsupportedStatement(), bind }))
    const DB: D1Database = { ...unsupportedDatabase(), prepare }

    await searchRecentTickerCoverage({ DB }, ['NVDA'], 14, new Date('2026-08-28T01:00:00.000Z'))

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('brief.id <> ?'))
    expect(bind).toHaveBeenCalledWith(
      '2026-08-14T01:00:00.000Z',
      '2026-08-28T01:00:00.000Z',
      'brief-2026-08-27',
      '["NVDA"]',
    )
  })

  it('does not return unrelated rows from a large recent window', async () => {
    const store = sqliteD1([
      'CREATE TABLE research_briefs (id TEXT PRIMARY KEY, published_at TEXT, payload_json TEXT)',
    ])
    const now = new Date('2026-08-27T13:30:00.000Z')
    const insert = store.sqlite.prepare(
      'INSERT INTO research_briefs (id, published_at, payload_json) VALUES (?, ?, ?)',
    )
    const idea = (symbol: string) => JSON.stringify({
      ideas: [{
        description: `${symbol} description`,
        direction: 'bullish',
        headline: `${symbol} headline`,
        risk: `${symbol} risk`,
        symbol,
      }],
    })
    try {
      for (let index = 0; index < 60; index += 1) {
        insert.run(`meta-${index}`, new Date(now.getTime() - index * 60_000).toISOString(), idea('META'))
      }
      insert.run('nvda', '2026-08-26T13:30:00.000Z', idea('NVDA'))

      await expect(searchRecentTickerCoverage({ DB: store.database }, ['NVDA'], 14, now))
        .resolves.toEqual([expect.objectContaining({ symbol: 'NVDA' })])
    } finally {
      store.close()
    }
  })

  it('does not query D1 when there is no bounded ticker scope', async () => {
    const prepare = vi.fn()
    const DB: D1Database = { ...unsupportedDatabase(), prepare }
    await expect(searchRecentTickerCoverage({ DB }, [])).resolves.toEqual([])
    expect(prepare).not.toHaveBeenCalled()
  })

  it('fails when coverage storage is unavailable', async () => {
    await expect(searchRecentTickerCoverage({}, ['NVDA']))
      .rejects.toThrow('RecentCoverageUnavailable')
  })

  it('fails when a stored coverage row is malformed', async () => {
    const all = vi.fn().mockResolvedValue({ results: [{ symbol: 'NVDA' }] })
    const bind = vi.fn(() => ({ ...unsupportedStatement(), all }))
    const DB: D1Database = {
      ...unsupportedDatabase(),
      prepare: () => ({ ...unsupportedStatement(), bind }),
    }

    await expect(searchRecentTickerCoverage({ DB }, ['NVDA']))
      .rejects.toThrow()
  })

  it('fails visibly for the retired legacy idea shape', async () => {
    const all = vi.fn().mockResolvedValue({ results: [{
      description: null,
      direction: 'bearish',
      headline: null,
      published_at: '2026-08-25T13:30:00.000Z',
      risk: 'Legacy risk',
      symbol: 'META',
    }] })
    const bind = vi.fn(() => ({ ...unsupportedStatement(), all }))
    const DB: D1Database = {
      ...unsupportedDatabase(),
      prepare: () => ({ ...unsupportedStatement(), bind }),
    }

    await expect(searchRecentTickerCoverage({ DB }, ['META']))
      .rejects.toThrow()
  })
})
