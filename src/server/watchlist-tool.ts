import { Type } from '@earendil-works/pi-ai'
import { type AgentTool } from '@earendil-works/pi-agent-core'

import { type AppEnv } from './env'
import { envelopeRows, JsonArraySchema, JsonObjectSchema, TextSchema, type JsonObject, type JsonValue } from '../domain/json-payload'
import { brokerApi } from './tastytrade'

type WatchlistEntry = {
  instrumentType: string
  symbol: string
}

type NormalizedWatchlist = {
  entries: WatchlistEntry[]
  name: string
  totalEntryCount: number
}

type WatchlistType = 'private' | 'public'

export type WatchlistReadResult =
  | {
    fetchedAt: string
    mode: 'index'
    source: 'tastytrade'
    status: 'ok'
    watchlistType: WatchlistType
    watchlists: Array<{ entryCount: number; name: string }>
  }
  | {
    fetchedAt: string
    mode: 'detail'
    source: 'tastytrade'
    status: 'not_found'
    watchlistName: string
    watchlistType: WatchlistType
  }
  | {
    entries: WatchlistEntry[]
    fetchedAt: string
    mode: 'detail'
    source: 'tastytrade'
    status: 'ok'
    totalEntryCount: number
    truncated: boolean
    watchlistName: string
    watchlistType: WatchlistType
  }

const MAX_WATCHLISTS = 100
const MAX_RETURNED_ENTRIES = 200

export const WatchlistReadParameters = Type.Object({
  watchlistName: Type.Optional(Type.String({
    description: 'Exact tastytrade watchlist name. Omit to list names without their symbols.',
    maxLength: 64,
    minLength: 1,
    pattern: '^(?=.*\\S)[^/]+$',
  })),
  watchlistType: Type.Optional(Type.Union([
    Type.Literal('private'),
    Type.Literal('public'),
  ], { description: 'Private tastytrade watchlists by default, or notable public watchlists.' })),
}, { additionalProperties: false })

function record(value: JsonValue): JsonObject | undefined {
  return JsonObjectSchema.safeParse(value).data
}

function text(value: JsonValue): string | undefined {
  return TextSchema.safeParse(value).data
}

/** Strictly normalize the tastytrade envelope before any private data reaches the model. */
export function watchlistsFromPayload(payload: JsonValue): NormalizedWatchlist[] {
  const candidate = envelopeRows(payload)
  if (!candidate || candidate.length > MAX_WATCHLISTS) throw new Error('Watchlists:invalid-response')

  return candidate.map((value) => {
    const row = record(value)
    const name = text(row?.name)
    const rawEntries = JsonArraySchema.safeParse(row?.['watchlist-entries']).data
    if (!row || !name || name.length > 64 || !rawEntries) {
      throw new Error('Watchlists:invalid-response')
    }
    const entries = rawEntries.slice(0, MAX_RETURNED_ENTRIES).map((rawEntry) => {
      const entry = record(rawEntry)
      const symbol = text(entry?.symbol)
      const instrumentType = text(entry?.['instrument-type'])
      if (!symbol || symbol.length > 64 || !instrumentType || instrumentType.length > 64) {
        throw new Error('Watchlists:invalid-response')
      }
      return { instrumentType, symbol }
    })
    return { entries, name, totalEntryCount: rawEntries.length }
  })
}

export async function readWatchlists(
  env: AppEnv,
  requestedName?: string,
  watchlistType: WatchlistType = 'private',
  now = new Date(),
): Promise<WatchlistReadResult> {
  let payload: JsonValue
  try {
    payload = await brokerApi().tastyRequest(env, watchlistType === 'public' ? '/public-watchlists' : '/watchlists')
  } catch {
    throw new Error(`${watchlistType === 'public' ? 'Public' : 'Private'} tastytrade watchlists are unavailable.`)
  }

  let watchlists: NormalizedWatchlist[]
  try {
    watchlists = watchlistsFromPayload(payload)
  } catch {
    throw new Error(`${watchlistType === 'public' ? 'Public' : 'Private'} tastytrade watchlists returned an invalid response.`)
  }

  const watchlistName = requestedName?.trim()
  const fetchedAt = now.toISOString()
  if (!watchlistName) {
    return {
      fetchedAt,
      mode: 'index',
      source: 'tastytrade',
      status: 'ok',
      watchlistType,
      watchlists: watchlists.map((watchlist) => ({
        entryCount: watchlist.totalEntryCount,
        name: watchlist.name,
      })),
    }
  }

  const matches = watchlists.filter((watchlist) => watchlist.name === watchlistName)
  if (matches.length !== 1) {
    return { fetchedAt, mode: 'detail', source: 'tastytrade', status: 'not_found', watchlistName, watchlistType }
  }
  const [watchlist] = matches
  return {
    entries: watchlist!.entries,
    fetchedAt,
    mode: 'detail',
    source: 'tastytrade',
    status: 'ok',
    totalEntryCount: watchlist!.totalEntryCount,
    truncated: watchlist!.totalEntryCount > watchlist!.entries.length,
    watchlistName: watchlist!.name,
    watchlistType,
  }
}

export function createWatchlistReadTool(env: AppEnv): AgentTool<typeof WatchlistReadParameters, WatchlistReadResult> {
  return {
    description: 'Read tastytrade watchlists on demand. Private lists are the default; public lists are also available. Omit watchlistName to retrieve names and entry counts only, then provide one exact name to retrieve that list. This tool is read-only.',
    execute: async (_toolCallId, params) => {
      const result = await readWatchlists(env, params.watchlistName, params.watchlistType)
      return {
        content: [{ text: JSON.stringify(result), type: 'text' }],
        details: result,
      }
    },
    executionMode: 'sequential',
    label: 'Reading watchlists',
    name: 'read_watchlists',
    parameters: WatchlistReadParameters,
  }
}
