import { describe, expect, it, vi } from 'vitest'

import { CATALYST_HORIZON_DAYS } from '../src/domain/catalyst'
import { readUpcomingCatalysts } from '../src/server/catalysts'
import {
  readCatalysts,
} from '../src/server/research-read-tools'
import { persistResearchCatalysts } from '../src/server/catalysts'
import { unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { migrationStore } from './sqlite-d1'

function d1WithResults(results: unknown[]) {
  const all = vi.fn().mockResolvedValue({ results })
  const bind = vi.fn(() => ({ ...unsupportedStatement(), all }))
  const first = vi.fn().mockResolvedValue(results[0])
  const prepare = vi.fn(() => ({ ...unsupportedStatement(), bind, first }))
  const DB: D1Database = { ...unsupportedDatabase(), prepare }
  return { all, bind, env: { DB }, first, prepare }
}

describe('research read tools', () => {
  it('queries bounded symbols for catalyst results', async () => {
    const catalyst = {
      id: 'tastytrade:NVDA:earnings', symbol: 'NVDA', kind: 'earnings', title: 'NVDA earnings',
      date: '2026-08-26', timing: 'after-hours', confidence: 'estimated',
      source: 'tastytrade market metrics', sourceUrl: 'https://example.com/metrics',
      updatedAt: '2026-08-13T10:00:00.000Z',
    }
    const db = d1WithResults([catalyst])
    const result = await readCatalysts(db.env, ['NVDA', 'NVDA'], 30, new Date('2026-08-13T12:00:00.000Z'))

    const { id: _id, ...withoutId } = catalyst
    expect(result).toMatchObject({ catalysts: [withoutId], horizonDays: 30, symbols: ['NVDA'], truncated: false })
    // The agent's rows are a projection: `id` restates symbol, kind and date, and no tool takes
    // one back. The website's own reader is the reason the domain schema still carries it.
    expect(result.catalysts[0]).not.toHaveProperty('id')
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('event_date BETWEEN ? AND ?'))
    expect(db.bind).toHaveBeenCalledWith('NVDA', '2026-08-13', '2026-09-12', 61)

    const site = d1WithResults([catalyst])
    await expect(readUpcomingCatalysts(site.env, ['NVDA'], new Date('2026-08-13T12:00:00.000Z')))
      .resolves.toEqual([catalyst])
  })

  it('hands the agent one row per event, and still reports a ceiling it hit', async () => {
    // Every sighting of an event costs the agent context and reads as another thing on the
    // calendar. What the ceiling left behind is a separate fact from what folded, so it is
    // still judged on the rows the query returned.
    const base = {
      symbol: 'INTC', kind: 'earnings', date: '2026-10-22', timing: 'unknown',
      description: null, source: 'tastytrade market metrics',
      sourceUrl: 'https://developer.tastytrade.com/open-api-spec/market-metrics/',
    }
    const db = d1WithResults([
      { ...base, id: 'exa:INTC:earnings:2026-10-22', confidence: 'estimated', title: 'Q3 2026 Earnings Report', updatedAt: '2026-09-21T17:54:02.486Z' },
      { ...base, id: 'tastytrade:INTC:earnings', confidence: 'confirmed', title: 'INTC earnings', updatedAt: '2026-08-28T02:15:52.966Z' },
    ])
    const result = await readCatalysts(db.env, ['INTC'], 60, new Date('2026-09-21T18:00:00.000Z'))

    expect(result.catalysts).toEqual([expect.objectContaining({ confidence: 'confirmed', title: 'INTC earnings' })])
    expect(result.truncated).toBe(false)
  })

  it('runs its own query against the real schema, and skips a superseded sighting', async () => {
    // The agent reads through the same source the site does, so a date one producer has since
    // moved is not handed to a model as a second event beside the one it moved to.
    const store = await migrationStore()
    try {
      const env = { DB: store.database }
      // The receipt a search leaves: it is what makes exa's later answer supersede its earlier.
      store.sqlite.prepare(
        `INSERT INTO catalyst_runs (symbol, source_provider, ran_at, catalyst_count, status)
         VALUES ('INTC', 'exa', '2026-08-21T18:00:00.000Z', 1, 'complete')`,
      ).run()
      const row = (date: string) => ({
        confidence: 'estimated' as const,
        date,
        id: `exa:INTC:earnings:${date}`,
        kind: 'earnings' as const,
        source: 'Exa search · example.com',
        sourceUrl: 'https://example.com/events',
        symbol: 'INTC',
        timing: 'unknown' as const,
        title: 'Q3 2026 earnings',
        updatedAt: '2026-09-21T17:54:02.486Z',
      })
      await persistResearchCatalysts(env, 'exa', [row('2026-10-22')], new Date('2026-08-21T18:00:00.000Z'))
      await persistResearchCatalysts(env, 'exa', [row('2026-10-23')], new Date('2026-09-21T18:00:00.000Z'))

      const result = await readCatalysts(env, ['INTC'], 60, new Date('2026-09-21T18:00:00.000Z'))
      expect(result.catalysts.map((catalyst) => catalyst.date)).toEqual(['2026-10-23'])
    } finally {
      store.close()
    }
  })

  it('rejects unbounded or malformed catalyst requests before D1', async () => {
    const db = d1WithResults([])
    await expect(readCatalysts(db.env, ['nvda'])).rejects.toThrow('symbols are invalid')
    await expect(readCatalysts(db.env, Array.from({ length: 21 }, (_, index) => `A${index}`))).rejects.toThrow('symbols are invalid')
    // A horizon is refused rather than rounded or widened past what any producer may write.
    await expect(readCatalysts(db.env, ['NVDA'], 30.5)).rejects.toThrow('horizon is invalid')
    await expect(readCatalysts(db.env, ['NVDA'], CATALYST_HORIZON_DAYS + 1)).rejects.toThrow('horizon is invalid')
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('reads the whole horizon a producer may write when none is asked for', async () => {
    const db = d1WithResults([])
    const result = await readCatalysts(db.env, ['NVDA'], undefined, new Date('2026-08-13T12:00:00.000Z'))

    expect(result.horizonDays).toBe(CATALYST_HORIZON_DAYS)
    expect(db.bind).toHaveBeenCalledWith('NVDA', '2026-08-13', '2027-02-09', 61)
  })
})
