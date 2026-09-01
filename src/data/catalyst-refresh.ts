import { useEffect, useSyncExternalStore } from 'react'

import {
  CatalystRefreshSchema,
  hasNearTermCatalyst,
  type Catalyst,
} from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'

/**
 * Catalyst coverage is seeded by attention: favoriting a symbol asks for a search, and so
 * does looking at one whose next month is empty. The server owns the window that decides
 * whether a search is actually bought, so asking is cheap and asking twice costs nothing.
 */
export async function requestCatalystRefresh(symbol: string): Promise<Catalyst[]> {
  const response = await fetch('/api/public-catalyst-refresh', {
    body: JSON.stringify({ symbol: EquitySymbolSchema.parse(symbol) }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw new Error(`Catalyst refresh failed (${response.status})`)
  return CatalystRefreshSchema.parse(await response.json()).catalysts
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
const answers = new Map<string, Catalyst[]>()
const listeners = new Set<() => void>()
let revision = 0
/** One shared empty list, so a caller can memoize on what a search bound rather than on a
    new array every render for the symbols no search has answered. */
const NO_CATALYSTS: readonly Catalyst[] = []

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

function searchOnce(symbol: string): void {
  if (searches.has(symbol)) return
  searches.add(symbol)
  // A failed search reads as "nothing found": the reader is looking at a calendar, not at
  // the state of our research, and the server keeps its own record of what went wrong.
  void requestCatalystRefresh(symbol)
    .catch(() => [])
    .then((rows) => {
      answers.set(symbol, rows)
      notify()
    })
  notify()
}

export type CatalystSearchState = {
  catalysts: readonly Catalyst[]
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
    searching: answer === undefined && searches.has(symbol),
  }
}
