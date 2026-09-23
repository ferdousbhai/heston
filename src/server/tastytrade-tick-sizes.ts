import {
  JsonArraySchema,
  jsonNumber,
  jsonObject,
  jsonText,
  type JsonValue,
} from '../domain/json-payload'

// A real tick schedule has only a handful of tiers; this wider ceiling rejects anomalous
// provider fan-out before the values become authoritative order-price validation data.
const MAX_TICK_TIERS_PER_KIND = 50

export type TastytradeTickSize = {
  appliesToSymbol: string | null
  threshold: number | null
  value: number
}

/** Normalize the two provider forms of a tick schedule before order-price validation. */
export function tastytradeTickSizes(value: JsonValue, label: string): TastytradeTickSize[] {
  if (value === undefined || value === null) return []
  const rows = JsonArraySchema.safeParse(value).data ?? [value]
  if (rows.length > MAX_TICK_TIERS_PER_KIND) throw new Error(`${label}:too-many-tick-sizes`)

  return rows.map((candidate) => {
    const row = jsonObject(candidate)
    const tick = jsonNumber(row?.value)
    if (!row || tick === undefined || tick <= 0) throw new Error(`${label}:invalid-tick-value`)

    const rawThreshold = row.threshold
    const thresholdText = jsonText(rawThreshold)?.trim().toLowerCase()
    const threshold = rawThreshold === undefined || rawThreshold === null || thresholdText === 'infinity'
      ? null
      : jsonNumber(rawThreshold)
    if (threshold !== null && (threshold === undefined || threshold <= 0)) {
      throw new Error(`${label}:invalid-tick-threshold`)
    }

    const rawSymbol = row.symbol
    const symbol = rawSymbol === undefined || rawSymbol === null ? null : jsonText(rawSymbol)?.trim()
    if (symbol === undefined || symbol !== null && (symbol.length === 0 || symbol.length > 128)) {
      throw new Error(`${label}:invalid-tick-symbol`)
    }
    return { appliesToSymbol: symbol, threshold, value: tick }
  })
}
