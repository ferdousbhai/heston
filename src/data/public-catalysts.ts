import { useEffect, useState } from 'react'

import { CatalystSchema, type Catalyst } from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'

const NO_CATALYSTS: readonly Catalyst[] = []
const inflight = new Map<string, Promise<readonly Catalyst[]>>()
const cache = new Map<string, readonly Catalyst[]>()

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
  const request = fetch(`/api/public-catalysts?symbol=${encodeURIComponent(parsed.data)}`, {
    headers: { Accept: 'application/json' },
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Catalysts failed (${response.status})`)
      const body = zCatalysts(await response.json())
      cache.set(parsed.data, body)
      return body
    })
    .catch(() => {
      inflight.delete(parsed.data)
      return NO_CATALYSTS
    })
    .finally(() => {
      inflight.delete(parsed.data)
    })
  inflight.set(parsed.data, request)
  return request
}

function zCatalysts(value: unknown): Catalyst[] {
  const parsed = CatalystSchema.array().safeParse(
    value && typeof value === 'object' && 'catalysts' in value
      ? (value as { catalysts: unknown }).catalysts
      : value,
  )
  return parsed.success ? parsed.data : []
}

export function usePublicCatalysts(symbol: string): readonly Catalyst[] {
  const [catalysts, setCatalysts] = useState<readonly Catalyst[]>(() => cache.get(symbol) ?? NO_CATALYSTS)

  useEffect(() => {
    let cancelled = false
    void loadPublicCatalysts(symbol).then((loaded) => {
      if (!cancelled) setCatalysts(loaded)
    })
    return () => { cancelled = true }
  }, [symbol])

  return catalysts
}
