import { describe, expect, it, vi } from 'vitest'

import {
  collectMarketMoverEvidence,
  type MarketMoverProvider,
} from '../src/server/research-market-movers'

function quote(symbol: string, changePercent: number) {
  return {
    averageDailyVolume3Month: 10_000_000,
    quoteType: 'EQUITY',
    regularMarketChangePercent: changePercent,
    regularMarketPrice: 100,
    regularMarketVolume: 25_000_000,
    shortName: `${symbol} Incorporated`,
    symbol,
    tradeable: false,
  }
}

describe('market-mover research', () => {
  it('balances and deduplicates movers, then keeps only recent same-symbol HTTPS news', async () => {
    const screen: MarketMoverProvider['screen'] = vi.fn(async (category) => ({
      quotes: category === 'gainer'
        ? [quote('NVDA', 7.5), { ...quote('SPY', 1.2), quoteType: 'ETF' }]
        : category === 'loser'
          ? [quote('INTC', -6.1)]
          : [quote('NVDA', 7.5), quote('AAPL', 3.2)],
    }))
    const searchNews: MarketMoverProvider['searchNews'] = vi.fn(async (symbol) => {
      if (symbol === 'INTC') throw new Error('unavailable')
      return {
        news: [{
          link: `https://news.example/${symbol.toLowerCase()}`,
          providerPublishTime: new Date('2026-08-26T12:00:00.000Z'),
          publisher: 'Example News',
          relatedTickers: [symbol],
          title: `${symbol} announces a material development`,
        }, {
          link: 'https://news.example/unrelated',
          providerPublishTime: new Date('2026-08-26T12:00:00.000Z'),
          publisher: 'Example News',
          relatedTickers: ['MSFT'],
          title: 'Unrelated story',
        }, {
          link: 'http://news.example/unsafe',
          providerPublishTime: new Date('2026-08-26T12:00:00.000Z'),
          publisher: 'Example News',
          relatedTickers: [symbol],
          title: 'Unsafe link',
        }],
      }
    })

    const evidence = await collectMarketMoverEvidence(
      { screen, searchNews },
      new Date('2026-08-26T13:30:00.000Z'),
    )

    expect(screen).toHaveBeenCalledTimes(3)
    expect(evidence.map((item) => item.marketMover?.symbol)).toEqual(['NVDA', 'INTC', 'AAPL'])
    expect(evidence[0]).toMatchObject({
      outbound: { url: 'https://news.example/nvda' },
      marketMover: { category: 'gainer', changePercent: 7.5 },
    })
    expect(evidence[1]).toMatchObject({
      title: 'INTC -6.10% · driver unconfirmed',
      marketMover: { category: 'loser' },
    })
    expect(evidence[1]?.context).toContain('must not be invented')
  })

  it('drops a symbol the domain schema would later refuse rather than admitting it', async () => {
    // MarketMoverInsightSchema parses these symbols again downstream and throws
    // on a miss, so a looser ingest rule here would take the required daily job
    // down from a best-effort source.
    const provider: MarketMoverProvider = {
      screen: async (category) => ({
        quotes: category === 'gainer' ? [quote('V2X', 9.1), quote('NVDA', 7.5)] : [],
      }),
      searchNews: async () => ({ news: [] }),
    }
    const evidence = await collectMarketMoverEvidence(provider)
    const symbols = evidence.map((item) => item.marketMover?.symbol)
    expect(symbols).toContain('NVDA')
    expect(symbols).not.toContain('V2X')
  })

  it('returns no evidence when every bounded screener is unavailable', async () => {
    const provider: MarketMoverProvider = {
      screen: async () => { throw new Error('unavailable') },
      searchNews: async () => ({ news: [] }),
    }
    await expect(collectMarketMoverEvidence(provider)).resolves.toEqual([])
  })
})
