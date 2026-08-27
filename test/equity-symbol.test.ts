import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  EQUITY_SYMBOL_PATTERN,
  EQUITY_SYMBOL_REGEX,
  EquitySymbolSchema,
  MAX_EQUITY_SYMBOL_LENGTH,
  POTENTIAL_PLAY_PATTERN,
} from '../src/domain/instrument'
import {
  AccountHistoryReadParameters,
  EQUITY_SYMBOL,
  InstrumentQuoteReadParameters,
  MarketMetricsReadParameters,
  OptionContractFindParameters,
  SymbolSearchParameters,
} from '../src/server/brokerage-read-contracts'
import { ExactOptionGreeksReadParameters } from '../src/server/option-greeks-tool'
import { WatchlistReadParameters } from '../src/server/watchlist-tool'

/**
 * A tool contract is JSON Schema, so it is parsed into this shape before being read.
 * Only the three nodes that can carry a `pattern` matter here.
 */
type SchemaNode = {
  items?: SchemaNode
  pattern?: string
  properties?: Record<string, SchemaNode>
}

const SchemaNodeSchema: z.ZodType<SchemaNode> = z.lazy(() => z.looseObject({
  items: SchemaNodeSchema.optional(),
  pattern: z.string().optional(),
  properties: z.record(z.string(), SchemaNodeSchema).optional(),
}))

/** Every `pattern` a tool contract advertises to the model, at any depth. */
function advertisedPatterns(node: SchemaNode): string[] {
  return [
    ...node.pattern === undefined ? [] : [node.pattern],
    ...node.items === undefined ? [] : advertisedPatterns(node.items),
    ...Object.values(node.properties ?? {}).flatMap(advertisedPatterns),
  ]
}

/**
 * The equity symbol rule is a single source of truth. Every tool contract, Zod schema, and
 * D1 constraint follows `EQUITY_SYMBOL_PATTERN`; a second copy anywhere is the bug this
 * file exists to catch.
 */
describe('equity symbol rule', () => {
  it('is the one symbol pattern every Dan tool contract advertises', () => {
    const patterns = [
      AccountHistoryReadParameters, InstrumentQuoteReadParameters, MarketMetricsReadParameters,
      OptionContractFindParameters, SymbolSearchParameters, ExactOptionGreeksReadParameters,
      WatchlistReadParameters,
    ].flatMap((contract) => advertisedPatterns(SchemaNodeSchema.parse(contract)))

    // An equity field takes a ticker and refuses a futures symbol. The two contracts that
    // accept `/ES` are the documented wider ones: a futures-or-equity history filter and a
    // free-text search query. Everything else must be the shared rule, spelled once.
    const equityPatterns = patterns.filter((pattern) => {
      const rule = new RegExp(pattern)
      return rule.test('AAPL') && !rule.test('/ES')
    })
    expect(equityPatterns.length).toBeGreaterThan(1)
    expect([...new Set(equityPatterns)]).toEqual([EQUITY_SYMBOL_PATTERN])
  })

  it('shares the compiled rule with the brokerage response guard', () => {
    expect(EQUITY_SYMBOL).toBe(EQUITY_SYMBOL_REGEX)
  })

  it('embeds the same symbol rule in the Daily Read play shorthand', () => {
    expect(POTENTIAL_PLAY_PATTERN.startsWith(EQUITY_SYMBOL_PATTERN.slice(0, -1))).toBe(true)
  })

  it('normalizes case and surrounding whitespace before matching', () => {
    expect(EquitySymbolSchema.parse('  nvda ')).toBe('NVDA')
  })

  it('admits nothing longer than the length migration 0014 bounds D1 to', () => {
    const longest = `${'A'.repeat(6)}/${'B'.repeat(3)}`
    expect(longest).toHaveLength(MAX_EQUITY_SYMBOL_LENGTH)
    expect(EquitySymbolSchema.parse(longest)).toBe(longest)
    expect(EquitySymbolSchema.safeParse(`${longest}C`).success).toBe(false)
  })

  // https://developer.tastytrade.com/api-overview/#tastytrade-symbology: "Equity symbols
  // contain only alphanumeric characters (A-Z, 0-9) with an occasional `/`."
  it.each([
    ['AAPL', 'the documented plain example'],
    ['BRK/A', 'the documented class-share example'],
    ['BRK/B', 'the class share Spice actually holds'],
    ['V2X', 'a listed equity carrying a digit'],
    ['F', 'a single-character root'],
    ['GOOGL', 'a five-character root'],
  ])('accepts %s (%s)', (symbol) => {
    expect(EquitySymbolSchema.parse(symbol)).toBe(symbol)
  })

  it.each([
    ['BRK.B', 'the NASDAQ dot rendering the broker 404s on'],
    ['BRK-B', "Yahoo's dash rendering"],
    ['/ES', 'a futures symbol, which never enters an equity field'],
    ['BRK/', 'a trailing slash'],
    ['A/B/C', 'more than one slash'],
    ['ABCDEFG', 'a root wider than the OCC root field'],
    ['SPY   221118C00400000', 'an OCC option symbol'],
    ['BRK B', 'a space'],
    ['', 'an empty symbol'],
  ])('rejects %s (%s)', (symbol) => {
    expect(EquitySymbolSchema.safeParse(symbol).success).toBe(false)
  })
})
