import { describe, expect, it } from 'vitest'

import { snapshotCatalyst } from '../src/domain/catalyst'
import { PublicMarketSnapshotSchema, slimPublicSnapshot, slimPublicTicker } from '../src/domain/market'
import { marketSnapshotFixture } from './fixtures/market'

describe('public snapshot wire', () => {
  it('drops empty sparklines and null earnings dates', () => {
    const ticker = slimPublicTicker({
      symbol: 'SPY',
      name: 'SPDR S&P 500 ETF',
      price: 1,
      change: 0,
      changePercent: 0,
      sparkline: [],
      earningsDate: null,
      updatedAt: '2026-09-16T13:30:00.000Z',
    })
    expect(ticker).not.toHaveProperty('sparkline')
    expect(ticker).not.toHaveProperty('earningsDate')
  })

  it('keeps a sparkline that actually has bars', () => {
    const ticker = slimPublicTicker({
      symbol: 'NVDA',
      name: 'NVIDIA',
      price: 1,
      change: 0,
      changePercent: 0,
      sparkline: [{ close: 1, sequence: 0, time: 1 }],
      earningsDate: '2026-11-18',
      updatedAt: '2026-09-16T13:30:00.000Z',
    })
    expect(ticker).toEqual(expect.objectContaining({
      earningsDate: '2026-11-18',
      sparkline: [{ close: 1, sequence: 0, time: 1 }],
    }))
  })

  it('ships the catalyst calendar without description or source', () => {
    const snapshot = PublicMarketSnapshotSchema.parse(slimPublicSnapshot({
      ...marketSnapshotFixture(),
      watchlists: [{ id: 'public-options-watch', kind: 'public', name: 'Options Watch', symbols: ['NVDA'] }],
    }))
    expect(snapshot.catalysts[0]).toEqual(snapshotCatalyst(marketSnapshotFixture().catalysts[0]!))
    expect(snapshot.catalysts[0]).not.toHaveProperty('description')
    expect(snapshot.catalysts[0]).not.toHaveProperty('source')
    expect(snapshot.catalysts[0]).not.toHaveProperty('sourceUrl')
  })
})
