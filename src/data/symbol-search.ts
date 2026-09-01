import { useEffect, useState } from 'react'

import { PublicSymbolLookupSchema, type PublicSymbolLookup } from '../domain/market'

/**
 * The loaded watchlist is not the whole market, so a search that matches nothing on it
 * falls through to the server, which resolves the symbol against the instrument catalog
 * and adds it to the maintained list. The row it returns renders like any other.
 */
export type SymbolSearchState =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'found'; lookup: PublicSymbolLookup }
  | { status: 'missing' }
  | { status: 'failed' }

// Long enough that a reader has stopped typing, short enough to feel like the same gesture.
const SEARCH_DEBOUNCE_MS = 350
const MIN_QUERY_LENGTH = 2

export async function lookupSymbol(
  query: string,
  signal?: AbortSignal,
): Promise<PublicSymbolLookup | undefined> {
  const response = await fetch(`/api/public-symbol-search?q=${encodeURIComponent(query)}`, { signal })
  if (response.status === 404 || response.status === 400) return undefined
  if (!response.ok) throw new Error(`Symbol search failed (${response.status})`)
  return PublicSymbolLookupSchema.parse(await response.json())
}

export function useSymbolSearch(query: string, enabled: boolean): SymbolSearchState {
  // The answer is stored with the query it answers, so a stale result never describes the
  // text now in the box: anything newer than the last answer still reads as searching.
  const [answer, setAnswer] = useState<{ query: string; state: SymbolSearchState }>()
  const trimmed = query.trim()
  const searchable = enabled && trimmed.length >= MIN_QUERY_LENGTH

  useEffect(() => {
    if (!searchable) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void lookupSymbol(trimmed, controller.signal)
        .then((lookup) => {
          if (controller.signal.aborted) return
          setAnswer({ query: trimmed, state: lookup ? { status: 'found', lookup } : { status: 'missing' } })
        })
        .catch(() => {
          if (!controller.signal.aborted) setAnswer({ query: trimmed, state: { status: 'failed' } })
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [searchable, trimmed])

  if (!searchable) return { status: 'idle' }
  return answer?.query === trimmed ? answer.state : { status: 'searching' }
}
