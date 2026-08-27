import { describe, expect, it } from 'vitest'

import {
  collectTickerResearchSources,
  type TickerResearchProvider,
} from '../src/server/research-ticker-sources'

describe('independent ticker research', () => {
  it('keeps only recent HTTPS headlines explicitly associated with the searched ticker', async () => {
    const provider: TickerResearchProvider = {
      searchNews: async () => ({
        news: [{
          link: 'https://example.com/nvidia-supply',
          providerPublishTime: new Date('2026-08-26T12:00:00.000Z'),
          publisher: 'Example Wire',
          relatedTickers: ['NVDA'],
          title: 'NVIDIA signs a new accelerator supply agreement',
        }, {
          link: 'https://example.com/meta-only',
          providerPublishTime: new Date('2026-08-26T12:00:00.000Z'),
          publisher: 'Example Wire',
          relatedTickers: ['META'],
          title: 'Wrong ticker',
        }, {
          link: 'http://example.com/insecure',
          providerPublishTime: new Date('2026-08-26T12:00:00.000Z'),
          publisher: 'Example Wire',
          relatedTickers: ['NVDA'],
          title: 'Insecure link',
        }, {
          link: 'https://www.reddit.com/r/investing/comments/example/',
          providerPublishTime: new Date('2026-08-26T12:00:00.000Z'),
          publisher: 'Reddit',
          relatedTickers: ['NVDA'],
          title: 'Discovery source is not independent evidence',
        }, {
          link: 'https://example.com/repackaged-discussion',
          providerPublishTime: new Date('2026-08-26T12:00:00.000Z'),
          publisher: 'Reddit',
          relatedTickers: ['NVDA'],
          title: 'A repackaged discussion is not independent evidence',
        }],
      }),
    }

    const evidence = await collectTickerResearchSources(
      ['NVDA'],
      provider,
      new Date('2026-08-27T13:30:00.000Z'),
    )

    expect(evidence).toEqual([expect.objectContaining({
      outbound: expect.objectContaining({ url: 'https://example.com/nvidia-supply' }),
      source: 'Yahoo Finance ticker research',
      symbols: ['NVDA'],
    })])
    expect(evidence[0]?.context).toContain('evidence, not a ready-made thesis')
  })

  it('bounds discovery scope to six exact equity symbols', async () => {
    const provider: TickerResearchProvider = { searchNews: async () => ({ news: [] }) }
    await expect(collectTickerResearchSources(
      ['AAPL', 'META', 'NVDA', 'TSLA', 'SPY', 'AMD', 'INTC'],
      provider,
    )).rejects.toThrow()
  })
})
