import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_ATTENTION_SYMBOLS,
  noteSymbolAttention,
  readsSymbols,
  type SymbolNamingCall,
} from '../src/server/symbol-attention'
import { migrationStore } from './sqlite-d1'

/**
 * The symbols `noteSymbolAttention` tries to buy a search for, in order. Each attempt starts with
 * one catalog read for exactly that symbol, and an empty catalog ends it there, so the reads are
 * the attempts and no search is ever bought.
 */
async function attemptedSymbols(call: SymbolNamingCall): Promise<unknown[]> {
  const store = await migrationStore()
  const attempted: unknown[] = []
  const prepare = store.database.prepare.bind(store.database)
  const database = Object.assign(store.database, {
    prepare: (query: string) => {
      const statement = prepare(query)
      if (!query.includes('FROM instrument_catalog')) return statement
      const bind = statement.bind.bind(statement)
      return Object.assign(statement, {
        bind: (...values: unknown[]) => {
          attempted.push(...values)
          return bind(...values)
        },
      })
    },
  })
  try {
    await noteSymbolAttention({ DB: database }, call)
  } finally {
    store.close()
  }
  return attempted
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('symbol attention', () => {
  it('reads the symbols a caller chose to look at', async () => {
    expect(await attemptedSymbols({ symbols: ['nvda', '$hood'] })).toEqual(['NVDA', 'HOOD'])
    expect(await attemptedSymbols({ symbol: 'AAPL' })).toEqual(['AAPL'])
    // A call that names no instrument is not attention on one.
    expect(await attemptedSymbols({})).toEqual([])
    expect(await attemptedSymbols({ symbols: ['not a ticker at all'] })).toEqual([])
  })

  it('reads the underlying an option tool names', async () => {
    expect(await attemptedSymbols({ underlying: 'nvda' })).toEqual(['NVDA'])
    expect(await attemptedSymbols({
      contracts: [
        { underlying: 'AAPL' },
        { underlying: '$aapl' },
        { underlying: 'not a ticker at all' },
        { underlying: 'hood' },
      ],
    })).toEqual(['AAPL', 'HOOD'])
  })

  it('does not treat a free-text symbol search as attention on a symbol', () => {
    // A query is a prefix or a company name as often as a ticker; "APPLE" is not AAPL.
    expect(readsSymbols('search_symbols')).toBe(false)
    expect(readsSymbols('find_option_contracts')).toBe(true)
    expect(readsSymbols('read_option_greeks')).toBe(true)
  })

  it('bounds one call so it cannot sweep the universe', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const many = Array.from({ length: 40 }, (_, index) => `SYM${index}`)
    expect(await attemptedSymbols({ symbols: many })).toEqual(many.slice(0, MAX_ATTENTION_SYMBOLS))
  })

  it('counts the names a call named past the search budget instead of dropping them silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const many = Array.from({ length: 40 }, (_, index) => `SYM${index}`)

    // An empty catalog names none of them, so no search is bought; only the count is observed.
    const store = await migrationStore()
    await noteSymbolAttention({ DB: store.database }, { symbols: many })
    store.close()

    expect(warn).toHaveBeenCalledWith('SymbolAttentionSymbolsDropped', 40 - MAX_ATTENTION_SYMBOLS)
  })

  it('logs nothing when a call stays inside the budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const store = await migrationStore()
    await noteSymbolAttention({ DB: store.database }, { symbols: ['NVDA', 'AAPL'] })
    store.close()

    expect(warn).not.toHaveBeenCalled()
  })

  it('does not treat the whole-universe read as attention on every name in it', () => {
    // `read_watchlist` answers with everything; counting that as attention would turn one call
    // into a search per tracked symbol, which is the opposite of following a reader.
    expect(readsSymbols('read_watchlist')).toBe(false)
    expect(readsSymbols('read_catalysts')).toBe(true)
    expect(readsSymbols('read_instrument_quotes')).toBe(true)
  })
})
