import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { generateDailyResearch, shouldRunDailyResearch } from '../src/server/research'
import {
  resetResearchSources,
  setResearchSources,
  type ResearchSources,
} from '../src/server/research-sources'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { unsupportedAi } from './fake-ai'

const headlines = { collectResearchSources: vi.fn(async () => []) } satisfies ResearchSources
const broker = stubBroker()

beforeEach(() => {
  broker.loadMarketSnapshot.mockResolvedValue({ tickers: [] })
  setBrokerApi(broker)
  setResearchSources(headlines)
})

afterEach(() => {
  resetBrokerApi()
  resetResearchSources()
})

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
    const run = vi.fn().mockResolvedValue({ response: JSON.stringify({
      id: 'brief-2026-08-14', publishedAt: '2026-08-14T13:30:00.000Z',
      title: 'Daily brief', summary: 'Summary', regime: 'Selective', regimeDetail: 'Defined risk',
      ideas: [{
        symbol: 'SPY', direction: 'Cautiously bullish', setup: 'Call spread', thesis: 'Breadth',
        risk: 'Reversal', horizon: '30 days',
      }], sources: [],
    }) })
    const secret: SecretsStoreSecret = { get: async () => 'secret' }
    const brief = await generateDailyResearch({
      AI: { ...unsupportedAi(), run },
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    }, new Date('2026-08-14T13:30:00.000Z'))

    expect(run.mock.calls[0]?.[1]).toMatchObject({ response_format: { type: 'json_object' } })
    expect(brief.ideas[0]?.direction).toBe('bullish')
  })
})
