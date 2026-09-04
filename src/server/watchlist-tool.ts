import { type AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

import { EQUITY_SYMBOL_PATTERN, EquitySymbolType } from '../domain/instrument'
import { MAX_WATCHLIST_SYMBOLS } from '../domain/watchlist'
import { WatchlistActionParameters, WatchlistActionSchema } from './agent-contracts'
import { internalWatchlistWriter } from './internal-watchlist'
import { watchlistWriter } from './watchlist-actions'
import { textResult } from './agent-tool-result'
import { type AppEnv } from './env'
import {
  readInternalWatchlist,
  readInternalWatchlistSymbolDetails,
  type InternalWatchlistSymbolDetails,
} from './internal-watchlist'


export type WatchlistReadResult =
  | {
    fetchedAt: string
    mode: 'index'
    source: 'spice'
    status: 'ok'
    symbols: string[]
  }
  | {
    fetchedAt: string
    mode: 'detail'
    source: 'spice'
    status: 'not_found'
    symbol: string
  }
  | {
    details: InternalWatchlistSymbolDetails
    fetchedAt: string
    mode: 'detail'
    source: 'spice'
    status: 'ok'
  }

export const WatchlistReadParameters = Type.Object({
  symbol: Type.Optional(Type.String({
    description: 'Omit for the index; provide for retained provenance.',
    pattern: EQUITY_SYMBOL_PATTERN,
  })),
}, { additionalProperties: false })

async function readWatchlist(env: AppEnv, symbol?: string): Promise<WatchlistReadResult> {
  const fetchedAt = new Date().toISOString()
  if (!symbol) {
    // Symbols only. The index answers "what is loaded" for up to 500 names; provenance and
    // instrument type are what the per-symbol mode below exists to return.
    const symbols = (await readInternalWatchlist(env)).map((item) => item.symbol)
    return {
      fetchedAt,
      symbols,
      mode: 'index',
      source: 'spice',
      status: 'ok',
    }
  }
  const details = await readInternalWatchlistSymbolDetails(env, symbol)
  return details
    ? { details, fetchedAt, mode: 'detail', source: 'spice', status: 'ok' }
    : { fetchedAt, mode: 'detail', source: 'spice', status: 'not_found', symbol }
}

export function createWatchlistReadTool(env: AppEnv): AgentTool<typeof WatchlistReadParameters, WatchlistReadResult> {
  return {
    description: 'Private watchlist; optional symbol returns retained provenance.',
    execute: async (_toolCallId, params) => textResult(await readWatchlist(env, params.symbol)),
    label: 'Reading watchlist',
    name: 'read_watchlist',
    parameters: WatchlistReadParameters,
  }
}

const RememberSymbolsParameters = Type.Object({
  symbols: Type.Array(EquitySymbolType, { maxItems: MAX_WATCHLIST_SYMBOLS, minItems: 1 }),
}, { additionalProperties: false })

/**
 * Additive only, and available to any member. The internal watchlist is shared — it drives the
 * market surface every reader sees — but admitting a name is already what a visitor's search
 * does, so this adds no authority a member did not have. Removing one is not the same act and
 * is owner-only below.
 */
export function createRememberSymbolsTool(
  env: AppEnv,
): AgentTool<typeof RememberSymbolsParameters, { remembered: string[] }> {
  return {
    description: 'Add substantively discussed tickers to the shared watchlist so they stay loaded. '
      + 'Only names a conversation actually developed; an incidental mention does not count.',
    execute: async (_toolCallId, params) => {
      const remembered = await internalWatchlistWriter().ensureSymbols(env, params.symbols, 'agent-discussion')
      return textResult({ remembered })
    },
    executionMode: 'sequential',
    label: 'Remembering symbols',
    name: 'remember_symbols',
    parameters: RememberSymbolsParameters,
  }
}

/**
 * Pruning the shared list back to a working set is an owner act: it changes what every reader
 * sees, and a member removing a name would take it from everyone.
 */
export function createWatchlistManageTool(
  env: AppEnv,
): AgentTool<typeof WatchlistActionParameters, unknown> {
  return {
    description: 'Add or remove symbols on the shared internal watchlist.',
    execute: async (_toolCallId, params) => textResult(
      await watchlistWriter().executeWatchlistAction(env, WatchlistActionSchema.parse(params)),
    ),
    executionMode: 'sequential',
    label: 'Updating watchlist',
    name: 'manage_watchlist',
    parameters: WatchlistActionParameters,
  }
}
