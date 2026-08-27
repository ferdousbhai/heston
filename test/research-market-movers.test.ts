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

/** Yahoo stamps screener quotes with their own observation time, in epoch seconds. */
function observedQuote(symbol: string, changePercent: number, observedAt: string) {
  return { ...quote(symbol, changePercent), regularMarketTime: Date.parse(observedAt) / 1_000 }
}

/** The weekday research job fires one second after the 09:30 New York open. */
const JUST_AFTER_THE_OPEN = new Date('2026-08-27T13:30:31.000Z')

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
    // down from a best-effort source. `BRK-B` is the screener's own dash rendering
    // of a class share, which is not tastytrade symbology and must not be admitted.
    const provider: MarketMoverProvider = {
      screen: async (category) => ({
        quotes: category === 'gainer' ? [quote('BRK-B', 9.1), quote('NVDA', 7.5)] : [],
      }),
      searchNews: async () => ({ news: [] }),
    }
    const evidence = await collectMarketMoverEvidence(provider)
    const symbols = evidence.map((item) => item.marketMover?.symbol)
    expect(symbols).toContain('NVDA')
    expect(symbols).not.toContain('BRK-B')
  })

  it('drops a screen quote whose change contradicts the screen it came from', async () => {
    // Production Daily Read, 09:30:31 ET: Yahoo still served the prior session's
    // regularMarket fields, so `day_gainers` returned ANF at -3.26% and BHVN at
    // -0.42%, and `day_losers` returned GENB at +3.28%. A shipped mover's
    // category must never contradict the sign of its own changePercent.
    const provider: MarketMoverProvider = {
      screen: async (category) => ({
        quotes: category === 'gainer'
          ? [quote('ANF', -3.26), quote('BHVN', -0.42)]
          : category === 'loser'
            ? [quote('GENB', 3.28)]
            : [],
      }),
      searchNews: async () => ({ news: [] }),
    }

    const evidence = await collectMarketMoverEvidence(provider, JUST_AFTER_THE_OPEN)

    expect(evidence).toEqual([])
  })

  it('never publishes a mover whose category disagrees with its changePercent sign', async () => {
    const provider: MarketMoverProvider = {
      screen: async (category) => ({
        quotes: category === 'gainer'
          ? [quote('ANF', -3.26), quote('NVDA', 7.5)]
          : category === 'loser'
            ? [quote('GENB', 3.28), quote('INTC', -6.1)]
            : [quote('AAPL', -2.4)],
      }),
      searchNews: async () => ({ news: [] }),
    }

    const evidence = await collectMarketMoverEvidence(provider, JUST_AFTER_THE_OPEN)

    for (const item of evidence) {
      const mover = item.marketMover
      if (!mover || mover.category === 'most-active') continue
      expect(Math.sign(mover.changePercent)).toBe(mover.category === 'gainer' ? 1 : -1)
    }
    expect(evidence.map((item) => item.marketMover?.symbol)).toEqual(['NVDA', 'INTC', 'AAPL'])
  })

  it('drops a directional quote that has barely moved', async () => {
    const provider: MarketMoverProvider = {
      screen: async (category) => ({
        quotes: category === 'gainer'
          ? [quote('BHVN', 0.42), quote('NVDA', 1.01)]
          : category === 'loser'
            ? [quote('KO', -0.99)]
            : [],
      }),
      searchNews: async () => ({ news: [] }),
    }

    const evidence = await collectMarketMoverEvidence(provider, JUST_AFTER_THE_OPEN)

    expect(evidence.map((item) => item.marketMover?.symbol)).toEqual(['NVDA'])
  })

  it('drops a quote observed in the prior New York session even when its sign agrees', async () => {
    // WBS shipped as a most active with 91.3M shares — 15x its three-month
    // average — one second after the open, because that was Tuesday's volume.
    const provider: MarketMoverProvider = {
      screen: async (category) => ({
        quotes: category === 'most-active'
          ? [observedQuote('WBS', 4.2, '2026-08-26T20:00:00.000Z')]
          : [observedQuote('NVDA', category === 'gainer' ? 7.5 : -7.5, '2026-08-26T20:00:00.000Z')],
      }),
      searchNews: async () => ({ news: [] }),
    }

    const evidence = await collectMarketMoverEvidence(provider, JUST_AFTER_THE_OPEN)

    expect(evidence).toEqual([])
  })

  it('keeps a quote observed in the current New York session', async () => {
    const provider: MarketMoverProvider = {
      screen: async (category) => ({
        quotes: category === 'gainer'
          ? [observedQuote('NVDA', 7.5, '2026-08-27T13:30:30.000Z')]
          : [],
      }),
      searchNews: async () => ({ news: [] }),
    }

    const evidence = await collectMarketMoverEvidence(provider, JUST_AFTER_THE_OPEN)

    expect(evidence.map((item) => item.marketMover?.symbol)).toEqual(['NVDA'])
  })

  it('returns no evidence when every bounded screener is unavailable', async () => {
    const provider: MarketMoverProvider = {
      screen: async () => { throw new Error('unavailable') },
      searchNews: async () => ({ news: [] }),
    }
    await expect(collectMarketMoverEvidence(provider)).resolves.toEqual([])
  })
})
