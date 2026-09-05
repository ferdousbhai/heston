import { describe, expect, it } from 'vitest'

import { readsSymbols, symbolsFromToolCall } from '../src/server/symbol-attention'

describe('symbol attention', () => {
  it('reads the symbols a caller chose to look at', () => {
    expect(symbolsFromToolCall({ symbols: ['nvda', '$hood'] })).toEqual(['NVDA', 'HOOD'])
    expect(symbolsFromToolCall({ symbol: 'AAPL' })).toEqual(['AAPL'])
    // A call that names no instrument is not attention on one.
    expect(symbolsFromToolCall({})).toEqual([])
    expect(symbolsFromToolCall({ symbols: ['not a ticker at all'] })).toEqual([])
  })

  it('bounds one call so it cannot sweep the universe', () => {
    const many = Array.from({ length: 40 }, (_, index) => `SYM${index}`)
    expect(symbolsFromToolCall({ symbols: many }).length).toBeLessThanOrEqual(5)
  })

  it('does not treat the whole-universe read as attention on every name in it', () => {
    // `read_watchlist` answers with everything; counting that as attention would turn one call
    // into a search per tracked symbol, which is the opposite of following a reader.
    expect(readsSymbols('read_watchlist')).toBe(false)
    expect(readsSymbols('read_catalysts')).toBe(true)
    expect(readsSymbols('read_instrument_quotes')).toBe(true)
  })
})
