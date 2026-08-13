import { describe, expect, it } from 'vitest'

import {
  MarketSnapshotSchema,
  volatilityVerdict,
} from '../src/domain/market'
import { demoSnapshot } from '../src/domain/demo'
import { percentMetric } from '../src/server/tastytrade'

describe('volatility classification', () => {
  it('treats low rank and percentile as cheap', () => {
    expect(volatilityVerdict({ ivRank: 22, ivPercentile: 27 })).toBe('cheap')
  })

  it('treats high rank or percentile as rich', () => {
    expect(volatilityVerdict({ ivRank: 75, ivPercentile: 60 })).toBe('rich')
    expect(volatilityVerdict({ ivRank: 50, ivPercentile: 82 })).toBe('rich')
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
