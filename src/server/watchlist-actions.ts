import { type AggregateWatchlistMutation, type WatchlistMutation } from '../domain/watchlist'
import { type AppEnv } from './env'
import { envelopeRows, JsonArraySchema, JsonObjectSchema, TextSchema, type JsonObject, type JsonValue } from '../domain/json-payload'
import { brokerApi } from './tastytrade'

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

function record(value: JsonValue): JsonObject | undefined {
  return JsonObjectSchema.safeParse(value).data
}

function text(value: JsonValue): string | undefined {
  return TextSchema.safeParse(value).data
}

/** Mutation reads are intentionally stricter and untruncated: an incomplete list must never be rewritten. */
export function mutableWatchlistsFromPayload(payload: JsonValue): MutableWatchlist[] {
  const body = record(payload)
  const data = record(body?.data ?? payload)
  const rows = envelopeRows(payload)
  if (!rows || rows.length > 100) throw new Error('WatchlistMutation:invalid-response')

  const pagination = record(body?.pagination ?? data?.pagination)
  const totalItems = Number(pagination?.['total-items'])
  if (Number.isFinite(totalItems) && totalItems > rows.length) {
    throw new Error('WatchlistMutation:incomplete-response')
  }

  return rows.map((value) => {
    const row = record(value)
    const name = text(row?.name)
    const rawEntries = JsonArraySchema.safeParse(row?.['watchlist-entries']).data
    const groupName = text(row?.['group-name']) ?? 'default'
    const rawOrderIndex = row?.['order-index'] ?? 9999
    const orderIndex = Number(rawOrderIndex)
    if (!row || !name || name.length > 64 || name.includes('/') || !rawEntries
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

async function loadWatchlists(env: AppEnv): Promise<MutableWatchlist[]> {
  const payload = await brokerApi().tastyRequest(env, '/watchlists')
  return mutableWatchlistsFromPayload(payload)
}

async function withMutationLease<T>(env: AppEnv, mutation: () => Promise<T>): Promise<T> {
  const gate = env.BROKER_GATE?.getByName('primary-account')
  if (!gate) throw new Error('WatchlistMutation:coordinator-unavailable')
  const token = await gate.acquireMutation()
  try {
    return await mutation()
  } finally {
    await gate.releaseMutation(token)
  }
}

function exactWatchlist(watchlists: readonly MutableWatchlist[], name: string): MutableWatchlist | undefined {
  const matches = watchlists.filter((watchlist) => watchlist.name === name)
  if (matches.length > 1) throw new Error('WatchlistMutation:ambiguous-name')
  return matches[0]
}

export async function executeWatchlistAction(
  env: AppEnv,
  action: WatchlistMutation,
): Promise<{ detail: string }> {
  return withMutationLease(env, () => executeWatchlistActionLocked(env, action))
}

async function executeWatchlistActionLocked(
  env: AppEnv,
  action: WatchlistMutation,
): Promise<{ detail: string }> {
  const watchlists = await loadWatchlists(env)
  const watchlist = exactWatchlist(watchlists, action.watchlistName)
  const path = `/watchlists/${encodeURIComponent(action.watchlistName)}`

  const symbols = [...new Set(action.symbols)]
  const requested = new Set(symbols)
  if (!watchlist) throw new Error('WatchlistMutation:not-found')

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
    await brokerApi().tastyRequest(env, path, {
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

/** The UI presents all private broker lists as one aggregate Watchlist without exposing broker list names. */
export async function executeAggregateWatchlistAction(
  env: AppEnv,
  action: AggregateWatchlistMutation,
): Promise<{ detail: string }> {
  return withMutationLease(env, () => executeAggregateWatchlistActionLocked(env, action))
}

async function executeAggregateWatchlistActionLocked(
  env: AppEnv,
  action: AggregateWatchlistMutation,
): Promise<{ detail: string }> {
  const watchlists = await loadWatchlists(env)
  if (!watchlists.length) throw new Error('WatchlistMutation:not-found')
  if (new Set(watchlists.map((watchlist) => watchlist.name)).size !== watchlists.length) {
    throw new Error('WatchlistMutation:ambiguous-name')
  }

  const symbols = [...new Set(action.symbols)]
  if (action.kind === 'add_watchlist_symbols') {
    const missing = symbols.filter((symbol) => !watchlists.some((watchlist) => watchlist.entries.some((entry) => (
      entry.instrumentType === 'Equity' && entry.symbol.toUpperCase() === symbol
    ))))
    if (!missing.length) return { detail: 'No watchlist changes were needed' }
    const target = watchlists[0]!
    await brokerApi().tastyRequest(env, `/watchlists/${encodeURIComponent(target.name)}`, {
      method: 'PUT',
      body: JSON.stringify(brokerPayload({
        ...target,
        entries: [...target.entries, ...missing.map((symbol) => ({ instrumentType: 'Equity', symbol }))],
      })),
    })
    return { detail: `${missing.join(', ')} added to Watchlist` }
  }

  const requested = new Set(symbols)
  const changed = new Set<string>()
  for (const watchlist of watchlists) {
    const nextEntries = watchlist.entries.filter((entry) => {
      const remove = entry.instrumentType === 'Equity' && requested.has(entry.symbol.toUpperCase())
      if (remove) changed.add(entry.symbol.toUpperCase())
      return !remove
    })
    if (nextEntries.length === watchlist.entries.length) continue
    await brokerApi().tastyRequest(env, `/watchlists/${encodeURIComponent(watchlist.name)}`, {
      method: 'PUT',
      body: JSON.stringify(brokerPayload({ ...watchlist, entries: nextEntries })),
    })
  }
  return {
    detail: changed.size ? `${[...changed].join(', ')} removed from Watchlist` : 'No watchlist changes were needed',
  }
}

/**
 * The watchlist writes the agent tools perform. Production goes through
 * `watchlistWriter()` so a test can install a recording stand-in with
 * `setWatchlistWriter` instead of replacing this module.
 */
function createWatchlistWriter() {
  return { executeWatchlistAction }
}

export type WatchlistWriter = ReturnType<typeof createWatchlistWriter>

let installedWatchlistWriter: WatchlistWriter = createWatchlistWriter()

/** The watchlist writes currently in force. */
export function watchlistWriter(): WatchlistWriter {
  return installedWatchlistWriter
}

/** Install a stand-in writer for a test; pair every call with `resetWatchlistWriter()`. */
export function setWatchlistWriter(next: WatchlistWriter): void {
  installedWatchlistWriter = next
}

/** Restore the real watchlist writes. */
export function resetWatchlistWriter(): void {
  installedWatchlistWriter = createWatchlistWriter()
}
