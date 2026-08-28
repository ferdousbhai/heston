import { describe, expect, it, vi } from 'vitest'

import { searchRecentTickerCoverage } from '../src/server/research-coverage'
import { unsupportedDatabase, unsupportedStatement } from './fake-d1'

describe('recent ticker coverage search', () => {
  it('queries exact requested tickers and keeps only the latest three rows per symbol', async () => {
    const results = [
      ...Array.from({ length: 4 }, (_, index) => ({
        description: `Current description ${index}`,
        direction: 'bullish',
        headline: `Current headline ${index}`,
        horizon: null,
        published_at: `2026-08-${String(26 - index).padStart(2, '0')}T13:30:00.000Z`,
        risk: `Current risk ${index}`,
        setup: null,
        symbol: 'NVDA',
        thesis: null,
      })),
      {
        description: null,
        direction: 'bearish',
        headline: null,
        horizon: 'Two months',
        published_at: '2026-08-25T13:30:00.000Z',
        risk: 'Legacy risk',
        setup: 'Legacy setup',
        symbol: 'META',
        thesis: 'Legacy thesis',
      },
    ]
    const all = vi.fn().mockResolvedValue({ results })
    const bind = vi.fn(() => ({ ...unsupportedStatement(), all }))
    const prepare = vi.fn(() => ({ ...unsupportedStatement(), bind }))
    const DB: D1Database = { ...unsupportedDatabase(), prepare }
    const now = new Date('2026-08-27T13:30:00.000Z')

    const coverage = await searchRecentTickerCoverage({ DB }, ['NVDA', 'NVDA', 'META'], now)

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("json_extract(idea.value, '$.symbol') IN (?, ?)"))
    expect(bind).toHaveBeenCalledWith(
      '2026-08-13T13:30:00.000Z',
      '2026-08-27T13:30:00.000Z',
      'brief-2026-08-27',
      'NVDA',
      'META',
    )
    expect(coverage.filter((item) => item.symbol === 'NVDA')).toHaveLength(3)
    expect(coverage).toContainEqual(expect.objectContaining({
      description: 'Legacy thesis Horizon: Two months.',
      headline: 'Legacy setup',
      symbol: 'META',
    }))
  })

  it('excludes the current market date so a rerun does not read its own brief as coverage', async () => {
    const all = vi.fn().mockResolvedValue({ results: [] })
    const bind = vi.fn(() => ({ ...unsupportedStatement(), all }))
    const prepare = vi.fn(() => ({ ...unsupportedStatement(), bind }))
    const DB: D1Database = { ...unsupportedDatabase(), prepare }

    await searchRecentTickerCoverage({ DB }, ['NVDA'], new Date('2026-08-28T01:00:00.000Z'))

    expect(prepare).toHaveBeenCalledWith(expect.stringContaining('brief.id <> ?'))
    expect(bind).toHaveBeenCalledWith(
      '2026-08-14T01:00:00.000Z',
      '2026-08-28T01:00:00.000Z',
      'brief-2026-08-27',
      'NVDA',
    )
  })

  it('does not query D1 when there is no bounded ticker scope', async () => {
    const prepare = vi.fn()
    const DB: D1Database = { ...unsupportedDatabase(), prepare }
    await expect(searchRecentTickerCoverage({ DB }, [])).resolves.toEqual([])
    expect(prepare).not.toHaveBeenCalled()
  })
})
