import { describe, expect, it } from 'vitest'

import {
  CandleSnapshotAccumulator,
  latestSessionCandles,
  MAX_INTRADAY_CANDLES,
  updateCandleSeries,
  type CandlePoint,
} from '../src/domain/candle'

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

  it('removes corrected candles and retains two regular sessions of five-minute bars', () => {
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

  it('carries the series across the overnight gap so a new session opens with context', () => {
    const priorClose = { time: 1_000, sequence: 0, close: 100 }
    const nextOpen = { time: priorClose.time + 17 * 60 * 60 * 1_000, sequence: 0, close: 101 }

    expect(updateCandleSeries([priorClose], nextOpen)).toEqual([priorClose, nextOpen])
  })

  it('commits a snapshot only once the transaction closes', () => {
    const accumulator = new CandleSnapshotAccumulator()
    const open = { time: 1_000, sequence: 0, close: 100, eventFlags: 0x4 }
    const middle = { time: 2_000, sequence: 0, close: 101, eventFlags: 0x1 }
    const end = { time: 3_000, sequence: 0, close: 102, eventFlags: 0x8 }

    expect(accumulator.accept('SPY', open)).toEqual({ status: 'buffering' })
    expect(accumulator.accept('SPY', middle)).toEqual({ status: 'buffering' })
    expect(accumulator.accept('SPY', end)).toEqual({
      status: 'complete',
      points: [
        { time: 1_000, sequence: 0, close: 100 },
        { time: 2_000, sequence: 0, close: 101 },
        { time: 3_000, sequence: 0, close: 102 },
      ],
    })
    // With no snapshot open, the next point is an ordinary live update the caller owns.
    expect(accumulator.accept('SPY', { time: 4_000, sequence: 0, close: 103, eventFlags: 0 }))
      .toEqual({ status: 'live' })
  })

  it('holds a snapshot open while the closing batch is still pending', () => {
    const accumulator = new CandleSnapshotAccumulator()
    accumulator.accept('SPY', { time: 1_000, sequence: 0, close: 100, eventFlags: 0x4 })

    // SNAPSHOT_END arrives, but TX_PENDING says the transaction has more to deliver.
    expect(accumulator.accept('SPY', { time: 2_000, sequence: 0, close: 101, eventFlags: 0x8 | 0x1 }))
      .toEqual({ status: 'buffering' })
    expect(accumulator.accept('SPY', { time: 3_000, sequence: 0, close: 102, eventFlags: 0 }))
      .toMatchObject({ status: 'complete' })
  })

  it('draws only the newest session, and the prior one until the next opens', () => {
    const priorSession = [
      { time: 1_000, sequence: 0, close: 100 },
      { time: 1_000 + 300_000, sequence: 0, close: 101 },
    ]
    const today = [
      { time: 1_000 + 17 * 60 * 60 * 1_000, sequence: 0, close: 102 },
      { time: 1_000 + 17 * 60 * 60 * 1_000 + 300_000, sequence: 0, close: 103 },
    ]

    expect(latestSessionCandles([...priorSession, ...today])).toEqual(today)
    expect(latestSessionCandles(priorSession)).toEqual(priorSession)
    expect(latestSessionCandles([])).toEqual([])
  })
})
