import { describe, expect, it } from 'vitest'

import {
  marketClosesAtFromTastytradeSession,
  marketOpensAtFromTastytradeSession,
  marketStateFromTastytradeSession,
} from '../src/server/tastytrade-market-normalization'

const NOW = new Date('2026-09-11T21:00:00.000Z')

describe('the next bell from a tastytrade session', () => {
  it('names the current open while it is still ahead', () => {
    const payload = { data: { state: 'Pre-Market', 'open-at': '2026-09-11T13:30:00.000Z', 'next-session': { 'open-at': '2026-09-14T13:30:00.000Z' } } }
    expect(marketOpensAtFromTastytradeSession(payload, new Date('2026-09-11T11:00:00.000Z'))).toBe('2026-09-11T13:30:00.000Z')
    expect(marketStateFromTastytradeSession(payload)).toBe('pre')
  })

  it('moves to the next session once the current open has rung', () => {
    // After hours on a Friday: the current session's open is behind, the next is Monday.
    const payload = { data: { state: 'After-Hours', 'open-at': '2026-09-11T13:30:00.000Z', 'next-session': { 'open-at': '2026-09-14T13:30:00.000Z' } } }
    expect(marketOpensAtFromTastytradeSession(payload, NOW)).toBe('2026-09-14T13:30:00.000Z')
    expect(marketStateFromTastytradeSession(payload)).toBe('after')
  })

  it('yields nothing rather than a bell that already rang', () => {
    expect(marketOpensAtFromTastytradeSession({ data: { state: 'Closed', 'open-at': '2026-09-11T13:30:00.000Z' } }, NOW)).toBeUndefined()
    expect(marketOpensAtFromTastytradeSession({ data: { state: 'Closed', 'open-at': null } }, NOW)).toBeUndefined()
    expect(marketOpensAtFromTastytradeSession({ data: { state: 'Closed' } }, NOW)).toBeUndefined()
  })

  it('refuses an open it cannot read rather than showing it as no bell at all', () => {
    expect(() => marketOpensAtFromTastytradeSession({ data: { state: 'Closed', 'open-at': 'soon' } }, NOW))
      .toThrow('TastytradeMarketSession:invalid-open-at')
    expect(() => marketOpensAtFromTastytradeSession({ data: { state: 'Closed', 'open-at': 1 } }, NOW))
      .toThrow('TastytradeMarketSession:invalid-open-at')
    expect(() => marketOpensAtFromTastytradeSession({
      data: { state: 'Closed', 'open-at': '2026-09-11T13:30:00.000Z', 'next-session': { 'open-at': 'Monday' } },
    }, NOW)).toThrow('TastytradeMarketSession:invalid-open-at')
  })
})

describe('the current close from a tastytrade session', () => {
  it('names the close while it is still ahead', () => {
    const payload = { data: { state: 'Open', 'open-at': '2026-09-11T13:30:00.000Z', 'close-at': '2026-09-11T20:00:00.000Z' } }
    expect(marketClosesAtFromTastytradeSession(payload, new Date('2026-09-11T14:00:00.000Z'))).toBe('2026-09-11T20:00:00.000Z')
  })

  it('yields nothing once the close has rung', () => {
    const payload = { data: { state: 'After-Hours', 'open-at': '2026-09-11T13:30:00.000Z', 'close-at': '2026-09-11T20:00:00.000Z' } }
    expect(marketClosesAtFromTastytradeSession(payload, NOW)).toBeUndefined()
    expect(marketClosesAtFromTastytradeSession({ data: { state: 'Open', 'close-at': null } }, NOW)).toBeUndefined()
  })

  it('refuses a close it cannot read rather than showing it as no close at all', () => {
    expect(() => marketClosesAtFromTastytradeSession({ data: { state: 'Open', 'close-at': 'soon' } }, NOW))
      .toThrow('TastytradeMarketSession:invalid-close-at')
  })
})
