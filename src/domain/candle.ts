import { z } from 'zod'

export const MAX_INTRADAY_CANDLES = 78
const INTRADAY_SESSION_GAP = 4 * 60 * 60 * 1_000

export const CandlePointSchema = z.object({
  time: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  close: z.number().finite().nonnegative(),
})

export type CandlePoint = z.infer<typeof CandlePointSchema>

function sameCandle(left: CandlePoint, right: Pick<CandlePoint, 'sequence' | 'time'>): boolean {
  return left.time === right.time && left.sequence === right.sequence
}

export function updateCandleSeries(
  current: readonly CandlePoint[],
  point: CandlePoint,
  remove = false,
  limit = MAX_INTRADAY_CANDLES,
): CandlePoint[] {
  const newest = current[current.length - 1]
  const source = newest && point.time > newest.time + INTRADAY_SESSION_GAP ? [] : current
  const next = source.filter((candidate) => !sameCandle(candidate, point))
  if (!remove) next.push(point)
  next.sort((left, right) => left.time - right.time || left.sequence - right.sequence)
  return next.slice(Math.max(0, next.length - limit))
}

/** Keep the richer intraday series unless the incoming data starts a newer session. */
export function reconcileCandleSeries(
  current: readonly CandlePoint[],
  incoming: readonly CandlePoint[],
  limit = MAX_INTRADAY_CANDLES,
): CandlePoint[] {
  if (!current.length) return incoming.slice(-limit)
  if (!incoming.length) return current.slice(-limit)

  const currentLatest = current[current.length - 1]!
  const incomingFirst = incoming[0]!
  const incomingLatest = incoming[incoming.length - 1]!
  if (incomingLatest.time <= currentLatest.time) return current.slice(-limit)
  if (incomingFirst.time > currentLatest.time + INTRADAY_SESSION_GAP) return incoming.slice(-limit)
  return (incoming.length >= current.length ? incoming : current).slice(-limit)
}
