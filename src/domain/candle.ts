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
