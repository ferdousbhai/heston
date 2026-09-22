import { describe, expect, it, vi } from 'vitest'

import { readUpcomingCatalysts } from '../src/server/catalysts'
import {
  readCatalysts,
} from '../src/server/research-read-tools'
import { unsupportedDatabase, unsupportedStatement } from './fake-d1'

function d1WithResults(results: unknown[]) {
  const all = vi.fn().mockResolvedValue({ results })
  const bind = vi.fn(() => ({ ...unsupportedStatement(), all }))
  const first = vi.fn().mockResolvedValue(results[0])
  const prepare = vi.fn(() => ({ ...unsupportedStatement(), bind, first }))
  const DB: D1Database = { ...unsupportedDatabase(), prepare }
  return { all, bind, env: { DB }, first, prepare }
}

describe('Dan research read tools', () => {
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
    await expect(readUpcomingCatalysts(site.env, new Date('2026-08-13T12:00:00.000Z')))
      .resolves.toEqual([catalyst])
  })

  it('rejects unbounded or malformed catalyst requests before D1', async () => {
    const db = d1WithResults([])
    await expect(readCatalysts(db.env, ['nvda'])).rejects.toThrow('symbols are invalid')
    await expect(readCatalysts(db.env, Array.from({ length: 21 }, (_, index) => `A${index}`))).rejects.toThrow('symbols are invalid')
    expect(db.prepare).not.toHaveBeenCalled()
  })
})
