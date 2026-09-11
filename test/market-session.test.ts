import { describe, expect, it } from 'vitest'

import {
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
    expect(marketOpensAtFromTastytradeSession({ data: { state: 'Closed', 'open-at': 'soon' } }, NOW)).toBeUndefined()
  })
})
