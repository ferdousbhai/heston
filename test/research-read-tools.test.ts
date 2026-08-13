import { describe, expect, it, vi } from 'vitest'

import { readCatalysts, readLatestResearch } from '../src/server/research-read-tools'

const brief = {
  id: 'daily-1', publishedAt: '2026-08-13T13:30:00.000Z', title: 'Wait for the pitch',
  summary: 'Liquidity is thin.', regime: 'Cautious', regimeDetail: 'Keep dry powder.',
  ideas: [], sources: [],
}

function d1WithResults(results: unknown[]) {
  const all = vi.fn().mockResolvedValue({ results })
  const bind = vi.fn(() => ({ all }))
  const first = vi.fn().mockResolvedValue(results[0])
  const prepare = vi.fn(() => ({ bind, first }))
  return { all, bind, env: { DB: { prepare } as unknown as D1Database }, first, prepare }
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

    expect(result).toMatchObject({ catalysts: [catalyst], horizonDays: 30, symbols: ['NVDA'], truncated: false })
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('event_date BETWEEN ? AND ?'))
    expect(db.bind).toHaveBeenCalledWith('NVDA', '2026-08-13', '2026-09-12', 101)
  })

  it('rejects unbounded or malformed catalyst requests before D1', async () => {
    const db = d1WithResults([])
    await expect(readCatalysts(db.env, ['nvda'])).rejects.toThrow('symbols are invalid')
    await expect(readCatalysts(db.env, Array.from({ length: 21 }, (_, index) => `A${index}`))).rejects.toThrow('symbols are invalid')
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('strictly parses the latest stored daily brief', async () => {
    const db = d1WithResults([{ payload_json: JSON.stringify(brief) }])
    await expect(readLatestResearch(db.env, new Date('2026-08-13T14:00:00.000Z'))).resolves.toMatchObject({
      brief, source: 'spice-research-store', status: 'ok',
    })

    const broken = d1WithResults([{ payload_json: '{}' }])
    await expect(readLatestResearch(broken.env)).rejects.toThrow()
  })
})
