import { type DirectAccountAction } from './agent-contracts'
import { type AppEnv } from './env'
import { tastyRequest } from './tastytrade'

type JsonRecord = Record<string, unknown>
type WatchlistAction = Extract<DirectAccountAction, {
  kind: 'add_watchlist_symbols' | 'delete_watchlist' | 'remove_watchlist_symbols'
}>

type WatchlistEntry = {
  instrumentType: string
  symbol: string
}

type MutableWatchlist = {
  entries: WatchlistEntry[]
  groupName: string
  name: string
  orderIndex: number
}

const INSTRUMENT_TYPES = new Set([
  'Cryptocurrency',
  'Equity',
  'Equity Option',
  'Future',
  'Future Option',
  'Warrant',
])

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Mutation reads are intentionally stricter and untruncated: an incomplete list must never be rewritten. */
export function mutableWatchlistsFromPayload(payload: unknown): MutableWatchlist[] {
  const body = record(payload)
  const rawData = body?.data ?? payload
  const data = record(rawData)
  const rows = Array.isArray(rawData)
    ? rawData
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(body?.items)
        ? body.items
        : undefined
  if (!rows || rows.length > 100) throw new Error('WatchlistMutation:invalid-response')

  const pagination = record(body?.pagination ?? data?.pagination)
  const totalItems = Number(pagination?.['total-items'])
  if (Number.isFinite(totalItems) && totalItems > rows.length) {
    throw new Error('WatchlistMutation:incomplete-response')
  }

  return rows.map((value) => {
    const row = record(value)
    const name = text(row?.name)
    const rawEntries = row?.['watchlist-entries']
    const groupName = text(row?.['group-name']) ?? 'default'
    const rawOrderIndex = row?.['order-index'] ?? 9999
    const orderIndex = Number(rawOrderIndex)
    if (!row || !name || name.length > 64 || name.includes('/') || !Array.isArray(rawEntries)
      || rawEntries.length > 2_000 || !Number.isSafeInteger(orderIndex)) {
      throw new Error('WatchlistMutation:invalid-response')
    }
    const entries = rawEntries.map((value) => {
      const entry = record(value)
      const symbol = text(entry?.symbol)
      const instrumentType = text(entry?.['instrument-type'])
      if (!entry || !symbol || symbol.length > 128 || !instrumentType || !INSTRUMENT_TYPES.has(instrumentType)) {
        throw new Error('WatchlistMutation:invalid-response')
      }
      return { instrumentType, symbol }
    })
    return { entries, groupName, name, orderIndex }
  })
}

function brokerPayload(watchlist: MutableWatchlist) {
  return {
    name: watchlist.name,
    'watchlist-entries': watchlist.entries.map((entry) => ({
      symbol: entry.symbol,
      'instrument-type': entry.instrumentType,
    })),
    'group-name': watchlist.groupName,
    'order-index': watchlist.orderIndex,
  }
}

async function loadExactWatchlist(env: AppEnv, name: string): Promise<MutableWatchlist | undefined> {
  const payload = await tastyRequest(env, '/watchlists')
  const matches = mutableWatchlistsFromPayload(payload).filter((watchlist) => watchlist.name === name)
  if (matches.length > 1) throw new Error('WatchlistMutation:ambiguous-name')
  return matches[0]
}

export async function executeWatchlistAction(
  env: AppEnv,
  action: WatchlistAction,
): Promise<{ detail: string }> {
  const watchlist = await loadExactWatchlist(env, action.watchlistName)
  const path = `/watchlists/${encodeURIComponent(action.watchlistName)}`

  if (action.kind === 'delete_watchlist') {
    if (!watchlist) throw new Error('WatchlistMutation:not-found')
    await tastyRequest(env, path, { method: 'DELETE' })
    return { detail: `${action.watchlistName} deleted` }
  }

  const symbols = [...new Set(action.symbols)]
  const requested = new Set(symbols)
  if (!watchlist) {
    if (action.kind === 'remove_watchlist_symbols') throw new Error('WatchlistMutation:not-found')
    const created: MutableWatchlist = {
      entries: symbols.map((symbol) => ({ instrumentType: 'Equity', symbol })),
      groupName: 'main',
      name: action.watchlistName,
      orderIndex: 9999,
    }
    await tastyRequest(env, '/watchlists', { method: 'POST', body: JSON.stringify(brokerPayload(created)) })
    return { detail: `${action.watchlistName} created with ${symbols.join(', ')}` }
  }

  const actuallyAdded = action.kind === 'add_watchlist_symbols'
    ? symbols.filter((symbol) => !watchlist.entries.some((entry) => (
        entry.instrumentType === 'Equity' && entry.symbol.toUpperCase() === symbol
      )))
    : []
  const actuallyRemoved = action.kind === 'remove_watchlist_symbols'
    ? symbols.filter((symbol) => watchlist.entries.some((entry) => (
        entry.instrumentType === 'Equity' && entry.symbol.toUpperCase() === symbol
      )))
    : []
  const nextEntries = action.kind === 'add_watchlist_symbols'
    ? [...watchlist.entries, ...actuallyAdded.map((symbol) => ({ instrumentType: 'Equity', symbol }))]
    : watchlist.entries.filter((entry) => entry.instrumentType !== 'Equity' || !requested.has(entry.symbol.toUpperCase()))

  if (nextEntries.length !== watchlist.entries.length) {
    await tastyRequest(env, path, {
      method: 'PUT',
      body: JSON.stringify(brokerPayload({ ...watchlist, entries: nextEntries })),
    })
  }
  const changed = action.kind === 'add_watchlist_symbols' ? actuallyAdded : actuallyRemoved
  return {
    detail: changed.length
      ? `${changed.join(', ')} ${action.kind === 'add_watchlist_symbols' ? 'added to' : 'removed from'} ${action.watchlistName}`
      : `No watchlist changes were needed for ${action.watchlistName}`,
  }
}
