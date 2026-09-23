import { useEffect, useState, useSyncExternalStore } from 'react'
import { z } from 'zod'

import { CatalystSchema, type Catalyst } from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { loadPublicJson } from './public-json'

const PublicCatalystsResponseSchema = z.object({ catalysts: z.array(CatalystSchema) })

const NO_CATALYSTS: readonly Catalyst[] = []
const inflight = new Map<string, Promise<readonly Catalyst[]>>()
const cache = new Map<string, readonly Catalyst[]>()
const listeners = new Set<() => void>()
/** Moves whenever a symbol's rows are dropped, so a card already on screen goes and asks again. */
let revision = 0

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Drop what this browser holds for a symbol, because a search just changed what the server
 * reports for it. The cache has no expiry -- a symbol's rows are read once per session -- so a
 * date the producer has since moved would otherwise sit on the runway beside the date it moved
 * to for as long as the reader stayed on the page, which is the duplicate a reader clicked the
 * button to resolve. The server decides which sighting is current; this only stops the browser
 * from answering from a copy taken before it did.
 */
export function forgetPublicCatalysts(symbol: string): void {
  const parsed = EquitySymbolSchema.safeParse(symbol)
  if (!parsed.success) return
  cache.delete(parsed.data)
  inflight.delete(parsed.data)
  revision += 1
  for (const listener of listeners) listener()
}

/**
 * Full catalyst rows for the focused symbol. The snapshot's calendar is enough for stories;
 * description and source are only drawn on the runway, so they ride this fetch.
 */
export function loadPublicCatalysts(symbol: string): Promise<readonly Catalyst[]> {
  const parsed = EquitySymbolSchema.safeParse(symbol)
  if (!parsed.success) return Promise.resolve(NO_CATALYSTS)
  const cached = cache.get(parsed.data)
  if (cached) return Promise.resolve(cached)
  const pending = inflight.get(parsed.data)
  if (pending) return pending
  // Only the request still registered for the symbol may settle it. `forgetPublicCatalysts`
  // unregisters one that started before a search moved the rows; that older request must not
  // cache the pre-search rows, nor clear the newer request's registration when it finishes.
  const current = () => inflight.get(parsed.data) === request
  const request: Promise<readonly Catalyst[]> = loadPublicJson(
    `/api/public-catalysts?symbol=${encodeURIComponent(parsed.data)}`,
    PublicCatalystsResponseSchema,
  )
    .then(({ catalysts: body }) => {
      // Parsed before caching: a malformed response must remain retryable, not become
      // a successful empty calendar for the rest of this browser session.
      if (current()) cache.set(parsed.data, body)
      return body
    })
    .catch(() => NO_CATALYSTS)
    .finally(() => {
      if (current()) inflight.delete(parsed.data)
    })
  inflight.set(parsed.data, request)
  return request
}

export function usePublicCatalysts(symbol: string): readonly Catalyst[] {
  const [catalysts, setCatalysts] = useState<readonly Catalyst[]>(() => cache.get(symbol) ?? NO_CATALYSTS)
  const dropped = useSyncExternalStore(subscribe, () => revision, () => 0)

  useEffect(() => {
    let cancelled = false
    void loadPublicCatalysts(symbol).then((loaded) => {
      if (!cancelled) setCatalysts(loaded)
    })
    return () => { cancelled = true }
  }, [dropped, symbol])

  return catalysts
}
