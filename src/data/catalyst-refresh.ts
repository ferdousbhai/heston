import { useEffect, useSyncExternalStore } from 'react'

import {
  CatalystRefreshSchema,
  hasNearTermCatalyst,
  type Catalyst,
  type CatalystRefresh,
} from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { forgetPublicCatalysts } from './public-catalysts'

/**
 * Catalyst coverage is seeded by attention: favoriting a symbol asks for a search, and so
 * does looking at one whose next month is empty. The server owns the window that decides
 * whether a search is actually bought, so asking is cheap and asking twice costs nothing.
 */
export async function requestCatalystRefresh(symbol: string, force = false): Promise<CatalystRefresh> {
  const response = await fetch('/api/public-catalyst-refresh', {
    body: JSON.stringify({ force, symbol: EquitySymbolSchema.parse(symbol) }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw new Error(`Catalyst refresh failed (${response.status})`)
  return CatalystRefreshSchema.parse(await response.json())
}

/**
 * One request per symbol per browsing session, shared by everything that asks: the server
 * would refuse the rest inside its own window anyway, and a reader flipping between two
 * symbols should not send one on every switch. A later look joins the same answer.
 *
 * This lives outside React because two views of the same symbol are asking one question.
 * `revision` is what every subscriber watches; it moves when a search starts or answers.
 */
const searches = new Set<string>()
const forcing = new Set<string>()
/** Symbols a search actually ran for, as opposed to ones a receipt merely refused. */
const searched = new Set<string>()
/** Symbols whose last search never answered, which a reader is told rather than shown empty. */
const failed = new Set<string>()
const answers = new Map<string, Catalyst[]>()
const listeners = new Set<() => void>()
let revision = 0
/** One shared empty list, so a caller can memoize on what a search bound rather than on a
    new array every render for the symbols no search has answered. */
const NO_CATALYSTS: readonly Catalyst[] = []
const FAILED_REFRESH: CatalystRefresh = { catalysts: [], ran: false, reason: 'failed' }

function notify(): void {
  revision += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function record(symbol: string, refresh: CatalystRefresh): void {
  answers.set(symbol, refresh.catalysts)
  // A search that ran may have moved a date this browser already holds a copy of, and the copy
  // has no expiry. Only what the search bound comes back here, so the rest of the symbol's
  // calendar is re-read rather than patched: the server is what knows which sighting is current.
  if (refresh.ran) forgetPublicCatalysts(symbol)
  // Only a search that actually ran can say the calendar is empty. A refusal leaves the
  // question open, so the reader is not told nothing is coming on the strength of a receipt.
  if (refresh.ran) searched.add(symbol)
  else searched.delete(symbol)
  if (refresh.reason === 'failed') failed.add(symbol)
  else failed.delete(symbol)
  notify()
}

function searchOnce(symbol: string): void {
  if (searches.has(symbol)) return
  searches.add(symbol)
  // A request that never answered is a failed search, not an empty calendar: telling a reader
  // nothing is scheduled on the strength of an outage is the one wrong answer here.
  void requestCatalystRefresh(symbol)
    .catch((): CatalystRefresh => FAILED_REFRESH)
    .then((refresh) => record(symbol, refresh))
  notify()
}

/**
 * Spend a search the window would have refused. The owner asked for this one on purpose, so
 * it runs whatever the receipt says, and a second click while one is in flight is ignored.
 */
export async function forceCatalystSearch(symbol: string): Promise<void> {
  if (forcing.has(symbol)) return
  forcing.add(symbol)
  notify()
  try {
    record(symbol, await requestCatalystRefresh(symbol, true))
  } catch {
    record(symbol, FAILED_REFRESH)
  } finally {
    forcing.delete(symbol)
    notify()
  }
}

export type CatalystSearchState = {
  catalysts: readonly Catalyst[]
  /** True once a search has run and bound nothing, which is not the same as never having looked. */
  confirmedEmpty: boolean
  /** True when the last search for this symbol never answered, so its calendar is unknown. */
  failed: boolean
  forcing: boolean
  refresh: () => void
  searching: boolean
}

/**
 * Search for what is coming when a reader looks at a symbol and finds nothing scheduled in
 * the near term. Whatever the search binds is returned for the caller to render, so the
 * calendar fills in on this visit rather than on the next snapshot. Nothing is claimed to
 * be underway until a request is actually in flight, which never happens on the server.
 */
export function useCatalystSearch(
  symbol: string,
  catalysts: readonly Catalyst[],
  now: Date,
): CatalystSearchState {
  useSyncExternalStore(subscribe, () => revision, () => 0)
  const covered = hasNearTermCatalyst(symbol, catalysts, now)

  useEffect(() => {
    if (!covered) searchOnce(symbol)
  }, [covered, symbol])

  const answer = answers.get(symbol)
  return {
    catalysts: answer ?? NO_CATALYSTS,
    confirmedEmpty: searched.has(symbol) && (answer?.length ?? 0) === 0,
    failed: failed.has(symbol),
    forcing: forcing.has(symbol),
    refresh: () => void forceCatalystSearch(symbol),
    searching: (answer === undefined && searches.has(symbol)) || forcing.has(symbol),
  }
}
