import {
  JsonArraySchema,
  jsonNumber,
  jsonObject,
  jsonText,
  type JsonValue,
} from '../domain/json-payload'
import { CallerVisibleError } from './caller-visible-error'

// A real tick schedule has only a handful of tiers; this wider ceiling rejects anomalous
// provider fan-out before the values become authoritative order-price validation data.
const MAX_TICK_TIERS_PER_KIND = 50

export type TastytradeTickSize = {
  threshold: number | null
  value: number
}

/** Normalize the two provider forms of a tick schedule before order-price validation. */
export function tastytradeTickSizes(value: JsonValue, label: string): TastytradeTickSize[] {
  if (value === undefined || value === null) return []
  const rows = JsonArraySchema.safeParse(value).data ?? [value]
  if (rows.length > MAX_TICK_TIERS_PER_KIND) throw new CallerVisibleError(`${label}:too-many-tick-sizes`)

  return rows.map((candidate) => {
    const row = jsonObject(candidate)
    const tick = jsonNumber(row?.value)
    if (!row || tick === undefined || tick <= 0) throw new CallerVisibleError(`${label}:invalid-tick-value`)

    const rawThreshold = row.threshold
    const thresholdText = jsonText(rawThreshold)?.trim().toLowerCase()
    const threshold = rawThreshold === undefined || rawThreshold === null || thresholdText === 'infinity'
      ? null
      : jsonNumber(rawThreshold)
    if (threshold !== null && (threshold === undefined || threshold <= 0)) {
      throw new CallerVisibleError(`${label}:invalid-tick-threshold`)
    }

    // The row's `symbol` names the underlying the schedule belongs to, which the caller already
    // chose; nothing reads it, so it is not carried and cannot refuse an order.
    return { threshold, value: tick }
  })
}
