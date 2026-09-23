import { z } from 'zod'

import { equitySymbolFromModelText } from '../domain/instrument'
import { refreshCatalystsForSymbol } from './catalyst-refresh'
import { type AppEnv } from './env'

/**
 * Agent attention buys the site a catalyst search, the same way a reader's does.
 *
 * The premise the catalyst store was built on is that coverage follows attention: a symbol is
 * worth paying a web search for once somebody looks at it. Browser readers have always paid that
 * way. Agent readers did not -- an agent could spend a whole session on a name and the site would
 * learn nothing from it, which inverted the premise for the surface that now sees the most use.
 *
 * The cost is unchanged. `refreshCatalystsForSymbol` claims a receipt before it searches and
 * refuses inside its window, so this is at most one search per symbol per window no matter how
 * many agents ask, and none at all for a symbol the instrument catalog cannot name. What the run
 * binds is stored for everyone, so a visitor who never runs an agent reads a calendar somebody
 * else's agent paid to fill.
 *
 * Deliberately fire-and-forget. The caller's turn is not held open for a web search it did not
 * ask for; the result lands for the next read and for the website.
 */
const AttentionParametersSchema = z.object({
  contracts: z.array(z.object({ underlying: z.string() })).optional(),
  symbol: z.string().optional(),
  symbols: z.array(z.string()).optional(),
  underlying: z.string().optional(),
})

/**
 * The tools whose calls count as attention on a symbol, named rather than inferred.
 *
 * `read_watchlist` is deliberately absent: it answers with the whole universe, and treating that
 * as attention on each name would turn one call into a sweep. So is `search_symbols`: its `query`
 * is free text -- a prefix or a company name as often as a ticker -- and reading "APPLE" or "NV"
 * as a symbol would buy a search for a name nobody looked at. Everything here names a symbol the
 * caller chose to look at.
 */
const ATTENTION_TOOLS = new Set([
  'find_option_contracts',
  'read_catalysts',
  'read_instrument_quotes',
  'read_market_metrics',
  'read_option_greeks',
  'read_price_history',
  'record_evidence',
])

/*
 * `record_catalysts` is absent on purpose. It names symbols too, but inside its `catalysts`
 * array rather than in either field this module reads, and a call it cannot parse is silently
 * no attention at all. Widening the shape here to reach into another tool's payload would put
 * the definition of "names a symbol" in two places; the recording writes the calendar it would
 * have bought anyway.
 */

export function readsSymbols(toolName: string): boolean {
  return ATTENTION_TOOLS.has(toolName)
}

/** Bounded so one call cannot fan out into a sweep of the whole universe. */
const MAX_ATTENTION_SYMBOLS = 5

/**
 * The slice of a tool call this reads. A tool in `ATTENTION_TOOLS` names an equity with `symbol`
 * or `symbols`, or names an option's underlying with `underlying` (`find_option_contracts`) or
 * `contracts[].underlying` (`read_option_greeks`). Every value is read as a ticker or dropped, and
 * a call carrying none of them is simply not attention on a symbol.
 */
export type SymbolNamingCall = z.infer<typeof AttentionParametersSchema>

export function symbolsFromToolCall(call: SymbolNamingCall): string[] {
  const parsed = AttentionParametersSchema.safeParse(call)
  if (!parsed.success) return []
  const named = [
    ...(parsed.data.symbols ?? []),
    ...(parsed.data.symbol ? [parsed.data.symbol] : []),
    ...(parsed.data.underlying ? [parsed.data.underlying] : []),
    ...(parsed.data.contracts ?? []).map((contract) => contract.underlying),
  ]
  const resolved = named
    .map((symbol) => equitySymbolFromModelText(symbol))
    .filter((symbol) => symbol !== undefined)
  return [...new Set(resolved)].slice(0, MAX_ATTENTION_SYMBOLS)
}

export async function noteSymbolAttention(env: AppEnv, call: SymbolNamingCall): Promise<void> {
  if (!env.DB) return
  for (const symbol of symbolsFromToolCall(call)) {
    try {
      await refreshCatalystsForSymbol(env, symbol)
    } catch (error) {
      // A search nobody asked for must never affect the answer that was asked for. The window
      // means a failure costs a receipt that ages out on its own, not a symbol stuck unsearched.
      console.error('SymbolAttentionRefreshFailed', error instanceof Error ? error.name : 'UnknownError')
    }
  }
}
