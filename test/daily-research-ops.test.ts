import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  alreadyPublishedToday,
  marketDate,
  readMarketState,
  shouldRunForMarket,
  unattendedPromptSuffix,
} from '../ops/spice-agent/daily-research.mjs'

afterEach(() => vi.unstubAllGlobals())

it('parses launcher session responses and rejects invalid states and opening times', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ marketState: 'pre', marketOpensAt: '2026-09-16T13:30:00.000Z' })))
  await expect(readMarketState()).resolves.toEqual({ state: 'pre', opensAt: '2026-09-16T13:30:00.000Z' })
  for (const body of [{ marketState: 'unexpected' }, { marketState: 'open', marketOpensAt: 42 }, { marketState: 'closed', marketOpensAt: 'yesterday' }]) {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)))
    await expect(readMarketState()).rejects.toThrow('SpiceDailyResearch:invalid-market-session')
  }
})

describe('owner-machine daily research skip', () => {
  it('treats the stored id as today\'s brief when it matches the NY market date', () => {
    expect(alreadyPublishedToday('recommendations-2026-09-16', '2026-09-16')).toBe(true)
    expect(alreadyPublishedToday('recommendations-2026-09-11', '2026-09-16')).toBe(false)
    expect(alreadyPublishedToday(undefined, '2026-09-16')).toBe(false)
  })

  it('names the US cash-session calendar date', () => {
    expect(marketDate(new Date('2026-09-16T13:35:00.000Z'))).toBe('2026-09-16')
    // 9:35 ET is 13:35 UTC in EDT; before midnight ET is still that session.
    expect(marketDate(new Date('2026-09-17T03:59:00.000Z'))).toBe('2026-09-16')
  })

  it('runs while the equity session is open or still pre', () => {
    expect(shouldRunForMarket({ state: 'open' })).toBe(true)
    expect(shouldRunForMarket({ state: 'pre' })).toBe(true)
    expect(shouldRunForMarket({ state: 'closed' })).toBe(false)
    expect(shouldRunForMarket({ state: 'after' })).toBe(false)
    expect(shouldRunForMarket({ state: 'unknown' })).toBe(false)
  })

  it('catches up after hours when today\'s bell has already rung, and skips a holiday', () => {
    const open = '2026-09-16T13:30:00.000Z'
    const evening = new Date('2026-09-16T23:00:00.000Z')
    const beforeBell = new Date('2026-09-16T13:00:00.000Z')
    expect(shouldRunForMarket({ state: 'after', opensAt: open }, evening)).toBe(true)
    expect(shouldRunForMarket({ state: 'after', opensAt: open }, beforeBell)).toBe(false)
    expect(shouldRunForMarket({
      state: 'closed',
      opensAt: '2026-09-17T13:30:00.000Z',
    }, evening)).toBe(false)
    expect(shouldRunForMarket({ state: 'closed' }, evening)).toBe(false)
  })

  it('hands launcher facts to the agent without treating them as citations', () => {
    const suffix = unattendedPromptSuffix({
      briefId: 'recommendations-2026-09-11',
      market: { opensAt: '2026-09-16T13:30:00.000Z', state: 'after' },
      today: '2026-09-16',
    })
    expect(suffix).toContain('US market date: 2026-09-16')
    expect(suffix).toContain('named open 2026-09-16T13:30:00.000Z')
    expect(suffix).toContain('recommendations-2026-09-11')
    expect(suffix).toContain('not publishable evidence')
  })
})
