import { type AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

import { EQUITY_SYMBOL_PATTERN } from '../domain/instrument'
import { textResult } from './agent-tool-result'
import { type AppEnv } from './env'
import {
  readInternalWatchlist,
  readInternalWatchlistSymbolDetails,
  type InternalWatchlistItem,
  type InternalWatchlistSymbolDetails,
} from './internal-watchlist'

type WatchlistItemSummary = Pick<InternalWatchlistItem, 'instrumentType' | 'origin' | 'symbol'>

export type WatchlistReadResult =
  | {
    fetchedAt: string
    items: WatchlistItemSummary[]
    mode: 'index'
    source: 'spice'
    status: 'ok'
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
    const allItems = await readInternalWatchlist(env)
    const items = allItems.map((item) => ({
      instrumentType: item.instrumentType,
      origin: item.origin,
      symbol: item.symbol,
    }))
    return {
      fetchedAt,
      items,
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
