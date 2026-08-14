import { beforeEach, describe, expect, it, vi } from 'vitest'

const dependencies = vi.hoisted(() => ({
  collectResearchSources: vi.fn(async () => []),
  loadMarketSnapshot: vi.fn(async () => ({ tickers: [] })),
}))
vi.mock('../src/server/research-sources', () => ({ collectResearchSources: dependencies.collectResearchSources }))
vi.mock('../src/server/tastytrade', () => ({ loadMarketSnapshot: dependencies.loadMarketSnapshot }))

import { generateDailyResearch, shouldRunDailyResearch } from '../src/server/research'

describe('daily research schedule', () => {
  beforeEach(() => vi.clearAllMocks())

  it('runs at 09:30 New York time during daylight saving time', () => {
    expect(shouldRunDailyResearch(new Date('2026-08-13T13:30:00.000Z'))).toBe(true)
    expect(shouldRunDailyResearch(new Date('2026-08-13T14:30:00.000Z'))).toBe(false)
  })

  it('runs at 09:30 New York time during standard time', () => {
    expect(shouldRunDailyResearch(new Date('2026-12-14T14:30:00.000Z'))).toBe(true)
    expect(shouldRunDailyResearch(new Date('2026-12-14T13:30:00.000Z'))).toBe(false)
  })

  it('does not generate weekend issues', () => {
    expect(shouldRunDailyResearch(new Date('2026-08-15T13:30:00.000Z'))).toBe(false)
  })

  it('uses JSON-object generation while Zod remains the structural boundary', async () => {
    const run = vi.fn(async (_model: string, _request: unknown) => ({ response: JSON.stringify({
      id: 'brief-2026-08-14', publishedAt: '2026-08-14T13:30:00.000Z',
      title: 'Daily brief', summary: 'Summary', regime: 'Selective', regimeDetail: 'Defined risk',
      ideas: [{
        symbol: 'SPY', direction: 'Cautiously bullish', setup: 'Call spread', thesis: 'Breadth',
        risk: 'Reversal', horizon: '30 days',
      }], sources: [],
    }) }))
    const secret = { get: async () => 'secret' } as SecretsStoreSecret
    const brief = await generateDailyResearch({
      AI: { run } as unknown as Ai,
      APP_MODE: 'live',
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    }, new Date('2026-08-14T13:30:00.000Z'))

    expect(run.mock.calls[0]?.[1]).toMatchObject({ response_format: { type: 'json_object' } })
    expect(brief.ideas[0]?.direction).toBe('bullish')
  })
})
