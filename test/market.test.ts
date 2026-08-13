import { describe, expect, it } from 'vitest'

import {
  MarketSnapshotSchema,
  optionsTemperatureCopy,
  volatilityVerdict,
} from '../src/domain/market'
import { demoSnapshot } from '../src/domain/demo'
import { percentMetric } from '../src/server/tastytrade'

describe('options temperature', () => {
  it('treats low rank and percentile as cheap', () => {
    expect(volatilityVerdict({ ivRank: 22, ivPercentile: 27 })).toBe('cheap')
  })

  it('treats high rank or percentile as rich', () => {
    expect(volatilityVerdict({ ivRank: 75, ivPercentile: 60 })).toBe('rich')
    expect(volatilityVerdict({ ivRank: 50, ivPercentile: 82 })).toBe('rich')
  })

  it('keeps the explanation tied to the same classification inputs', () => {
    const ticker = demoSnapshot().tickers.find((candidate) => candidate.symbol === 'SPY')!
    expect(optionsTemperatureCopy(ticker).title).toContain('cool')
    expect(optionsTemperatureCopy(ticker).detail).toContain('IV percentile is 23')
  })
})

describe('snapshot contract', () => {
  it('validates the complete offline seed', () => {
    expect(MarketSnapshotSchema.parse(demoSnapshot()).tickers.length).toBeGreaterThan(3)
  })
})

describe('tastytrade normalization', () => {
  it('normalizes tastytrade decimal ratios into percentage points', () => {
    expect(percentMetric('0.184', 50)).toBeCloseTo(18.4)
    expect(percentMetric(undefined, 72)).toBe(72)
    expect(percentMetric('1.5', 50, 500)).toBe(150)
  })
})
