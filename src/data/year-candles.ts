import { useEffect, useState } from 'react'

import { YearCandlesSchema } from '../domain/market'

/**
 * The year series is fetched once per session and only where something draws it. It changes
 * once a market day and is large enough that the market snapshot cannot carry it: a reader
 * refetches that on every tab focus, and most screens never render the chart at all.
 *
 * One shared request, outside React, so several views asking are one answer.
 */
let request: Promise<ReadonlyMap<string, readonly number[]>> | undefined

const NO_SERIES: ReadonlyMap<string, readonly number[]> = new Map()

export function loadYearCandles(): Promise<ReadonlyMap<string, readonly number[]>> {
  request ??= fetch('/api/public-year-candles', { headers: { Accept: 'application/json' } })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Year history failed (${response.status})`)
      const parsed = YearCandlesSchema.parse(await response.json())
      return new Map(parsed.series.map((entry) => [entry.symbol, entry.closes]))
    })
    .catch(() => {
      // A missing year chart is a column that stays empty, not a market a reader cannot read.
      // Clearing the promise lets a later view try again rather than caching the failure.
      request = undefined
      return NO_SERIES
    })
  return request
}

/** Loads the series only when something is actually going to draw it. */
export function useYearCandles(enabled: boolean): ReadonlyMap<string, readonly number[]> {
  const [series, setSeries] = useState<ReadonlyMap<string, readonly number[]>>(NO_SERIES)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void loadYearCandles().then((loaded) => {
      if (!cancelled) setSeries(loaded)
    })
    return () => { cancelled = true }
  }, [enabled])

  return series
}
