import { describe, expect, it } from 'vitest'

import { MAX_INTRADAY_CANDLES, updateCandleSeries, type CandlePoint } from '../src/domain/candle'

describe('intraday candle series', () => {
  it('sorts candles and replaces updates with the same time and sequence', () => {
    const first = { time: 1_000, sequence: 0, close: 100 }
    const second = { time: 2_000, sequence: 0, close: 101 }
    const initial = updateCandleSeries([second], first)

    expect(initial).toEqual([first, second])
    expect(updateCandleSeries(initial, { ...second, close: 102 })).toEqual([
      first,
      { ...second, close: 102 },
    ])
  })

  it('removes corrected candles and retains one regular session of five-minute bars', () => {
    const points = Array.from({ length: MAX_INTRADAY_CANDLES + 2 }, (_, index) => ({
      time: index * 300_000,
      sequence: 0,
      close: 100 + index,
    }))
    const bounded = points.reduce<CandlePoint[]>((series, point) => updateCandleSeries(series, point), [])

    expect(bounded).toHaveLength(MAX_INTRADAY_CANDLES)
    expect(bounded[0]?.time).toBe(600_000)
    expect(updateCandleSeries(bounded, bounded[0]!, true)).not.toContainEqual(bounded[0])
  })

  it('starts a new series after the overnight session gap', () => {
    const priorClose = { time: 1_000, sequence: 0, close: 100 }
    const nextOpen = { time: priorClose.time + 17 * 60 * 60 * 1_000, sequence: 0, close: 101 }

    expect(updateCandleSeries([priorClose], nextOpen)).toEqual([nextOpen])
  })
})
