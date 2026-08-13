import { describe, expect, it } from 'vitest'

import { isSameOriginWebSocketRequest, parseRequestedSymbols } from '../src/server/market-feed-contracts'

describe('market feed subscription boundary', () => {
  it('normalizes, deduplicates, bounds, and rejects invalid symbols', () => {
    const url = new URL('https://spice.test/api/stream?symbols=spy,NVDA,spy,../secret,BRK.B')
    expect(parseRequestedSymbols(url)).toEqual(['SPY', 'NVDA', 'BRK.B'])
  })

  it('rejects cross-origin WebSocket handshakes', () => {
    expect(isSameOriginWebSocketRequest(new Request('https://spice.test/api/stream', {
      headers: { Origin: 'https://spice.test' },
    }))).toBe(true)
    expect(isSameOriginWebSocketRequest(new Request('https://spice.test/api/stream', {
      headers: { Origin: 'https://evil.test' },
    }))).toBe(false)
  })
})
