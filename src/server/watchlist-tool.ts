import { Type } from '@earendil-works/pi-ai'
import { type AgentTool } from '@earendil-works/pi-agent-core'

import { type AppEnv } from './env'
import {
  readInternalWatchlist,
  readInternalWatchlistSymbolDetails,
  type InternalWatchlistItem,
  type InternalWatchlistSymbolDetails,
} from './internal-watchlist'

const MAX_RETURNED_ITEMS = 100
type WatchlistItemSummary = Pick<InternalWatchlistItem, 'instrumentType' | 'origin' | 'symbol'>

export type WatchlistReadResult =
  | {
    fetchedAt: string
    items: WatchlistItemSummary[]
    mode: 'index'
    source: 'spice'
    status: 'ok'
    totalItemCount: number
    truncated: boolean
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
    description: 'Exact equity symbol. Omit to read the consolidated internal watchlist.',
    pattern: '^[A-Z][A-Z.]{0,7}$',
  })),
}, { additionalProperties: false })

async function readWatchlist(env: AppEnv, symbol?: string, now = new Date()): Promise<WatchlistReadResult> {
  const fetchedAt = now.toISOString()
  if (!symbol) {
    const allItems = await readInternalWatchlist(env)
    const items = allItems.slice(0, MAX_RETURNED_ITEMS).map((item) => ({
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
      totalItemCount: allItems.length,
      truncated: allItems.length > items.length,
    }
  }
  const details = await readInternalWatchlistSymbolDetails(env, symbol)
  return details
    ? { details, fetchedAt, mode: 'detail', source: 'spice', status: 'ok' }
    : { fetchedAt, mode: 'detail', source: 'spice', status: 'not_found', symbol }
}

export function createWatchlistReadTool(env: AppEnv): AgentTool<typeof WatchlistReadParameters, WatchlistReadResult> {
  return {
    description: "Read Spice's consolidated internal private watchlist. Omit symbol for the list; provide one exact symbol for its retained one-time tastytrade seed provenance. This tool never reads tastytrade watchlist endpoints.",
    execute: async (_toolCallId, params) => {
      const result = await readWatchlist(env, params.symbol)
      return {
        content: [{ text: JSON.stringify(result), type: 'text' }],
        details: result,
      }
    },
    executionMode: 'sequential',
    label: 'Reading watchlist',
    name: 'read_watchlists',
    parameters: WatchlistReadParameters,
  }
}
