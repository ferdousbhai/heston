import { type Catalyst } from '../../src/domain/catalyst'
import { type CandlePoint } from '../../src/domain/candle'
import { type MarketSnapshot, type ResearchBrief, type Ticker, type Watchlist } from '../../src/domain/market'

const UPDATED_AT = '2026-08-13T13:31:00.000Z'
const FIVE_MINUTES = 5 * 60 * 1_000

function spark(base: number, deltas: number[]): CandlePoint[] {
  const end = Date.parse(UPDATED_AT)
  return deltas.map((delta, index) => ({
    time: end - (deltas.length - index - 1) * FIVE_MINUTES,
    sequence: 0,
    close: Number((base + delta).toFixed(2)),
  }))
}

export const marketTickersFixture: Ticker[] = [
  { symbol: 'SPY', name: 'SPDR S&P 500 ETF', assetType: 'etf', borrowRate: 0.25, lendability: 'Easy To Borrow', price: 691.24, yearLow: 481.8, yearHigh: 698.44, change: 3.82, changePercent: 0.56, sparkline: spark(685, [0, 1.2, 0.4, 2.5, 1.7, 3.8, 4.5, 3.9, 5.2, 6.24]), ivRank: 18, ivPercentile: 23, ivIndex: 14.8, ivIndex5DayChange: -0.7, historicalVolatility30Day: 12.9, ivHistoricalVolatility30DayDifference: 1.9, ivTermStructure: { frontExpiration: '2026-09-04', frontIv: 14.1, backExpiration: '2026-09-11', backIv: 14.8 }, liquidity: 5, earningsDate: null, position: false, updatedAt: UPDATED_AT },
  { symbol: 'NVDA', name: 'NVIDIA', assetType: 'stock', borrowRate: 0.4, lendability: 'Easy To Borrow', marketCap: 4_730_000_000_000, volume: 128_400_000, price: 191.68, yearLow: 86.62, yearHigh: 195.95, change: 4.91, changePercent: 2.63, sparkline: spark(181, [0, 2.4, 1.3, 3.1, 5.8, 4.4, 7.2, 8.1, 7.6, 10.68]), ivRank: 72, ivPercentile: 81, ivIndex: 48.2, ivIndex5DayChange: 3.4, historicalVolatility30Day: 42.1, ivHistoricalVolatility30DayDifference: 6.1, ivTermStructure: { frontExpiration: '2026-09-04', frontIv: 55.4, backExpiration: '2026-09-11', backIv: 48.8 }, liquidity: 5, earningsDate: '2026-08-26', position: true, updatedAt: UPDATED_AT },
  { symbol: 'SPCX', name: 'SpaceX Corporation', price: 24.83, change: -0.11, changePercent: -0.44, sparkline: spark(24.7, [0, .04, .02, .08, .05, .1, .07, .11, .09, .13]), ivRank: 26, ivPercentile: 31, ivIndex: 22.6, liquidity: 2, earningsDate: null, position: true, updatedAt: UPDATED_AT },
  { symbol: 'BE', name: 'Bloom Energy', price: 43.16, change: 1.27, changePercent: 3.03, sparkline: spark(41.2, [0, .25, .1, .6, .4, .9, 1.2, 1.05, 1.6, 1.96]), ivRank: 68, ivPercentile: 77, ivIndex: 63.4, liquidity: 3, earningsDate: '2026-11-05', position: false, updatedAt: UPDATED_AT },
  { symbol: 'INTC', name: 'Intel', assetType: 'stock', borrowRate: 0.6, lendability: 'Easy To Borrow', price: 31.72, yearLow: 17.67, yearHigh: 32.85, change: -0.38, changePercent: -1.18, sparkline: spark(32.2, [0, -.08, .03, -.12, -.2, -.16, -.31, -.26, -.4, -.48]), ivRank: 21, ivPercentile: 28, ivIndex: 34.7, ivIndex5DayChange: -2.1, historicalVolatility30Day: 37.4, ivHistoricalVolatility30DayDifference: -2.7, ivTermStructure: { frontExpiration: '2026-09-04', frontIv: 33.1, backExpiration: '2026-09-11', backIv: 35.7 }, liquidity: 5, earningsDate: '2026-10-22', position: false, updatedAt: UPDATED_AT },
  { symbol: 'AAPL', name: 'Apple', price: 236.41, change: -1.84, changePercent: -0.77, sparkline: spark(241, [0, -0.5, 0.3, -1.4, -2.1, -1.5, -3, -2.4, -3.7, -4.59]), ivRank: 46, ivPercentile: 52, ivIndex: 27.4, liquidity: 5, earningsDate: '2026-10-29', position: false, updatedAt: UPDATED_AT },
  { symbol: 'TSLA', name: 'Tesla', price: 338.12, change: -9.77, changePercent: -2.81, sparkline: spark(354, [0, -2.2, -1.1, -4.8, -6.4, -5.7, -9.2, -11.4, -12.2, -15.88]), ivRank: 84, ivPercentile: 89, ivIndex: 61.6, liquidity: 5, earningsDate: '2026-10-21', position: false, updatedAt: UPDATED_AT },
  { symbol: 'QQQ', name: 'Invesco QQQ', price: 618.73, change: 5.02, changePercent: 0.82, sparkline: spark(609, [0, 1.4, 0.8, 3.2, 4.7, 4.1, 6.5, 7.2, 8.4, 9.73]), ivRank: 24, ivPercentile: 31, ivIndex: 18.6, liquidity: 5, earningsDate: null, position: false, updatedAt: UPDATED_AT },
  { symbol: 'AMD', name: 'Advanced Micro Devices', price: 176.22, change: 2.08, changePercent: 1.19, sparkline: spark(170, [0, 0.8, -0.4, 1.7, 2.4, 2, 3.8, 4.2, 5.1, 6.22]), ivRank: 57, ivPercentile: 64, ivIndex: 43.5, liquidity: 4, earningsDate: '2026-11-03', position: false, updatedAt: UPDATED_AT },
  { symbol: 'IWM', name: 'iShares Russell 2000 ETF', price: 243.86, change: 1.37, changePercent: 0.57, sparkline: spark(239, [0, 0.3, -0.2, 1.1, 0.9, 2.4, 2.1, 3.2, 4, 4.86]), ivRank: 66, ivPercentile: 72, ivIndex: 25.9, liquidity: 5, earningsDate: null, position: false, updatedAt: UPDATED_AT },
  { symbol: 'META', name: 'Meta Platforms', assetType: 'stock', borrowRate: 0.35, lendability: 'Easy To Borrow', price: 782.17, yearLow: 479.8, yearHigh: 796.25, change: 8.31, changePercent: 1.07, sparkline: spark(767, [0, 1.3, 3.2, 2.7, 6.1, 5.4, 8, 10.2, 12.6, 15.17]), ivRank: 35, ivPercentile: 44, ivIndex: 32.8, ivIndex5DayChange: 1.1, historicalVolatility30Day: 29.2, ivHistoricalVolatility30DayDifference: 3.6, ivTermStructure: { frontExpiration: '2026-09-04', frontIv: 34.5, backExpiration: '2026-09-11', backIv: 31.9 }, liquidity: 4, earningsDate: '2026-10-28', position: true, updatedAt: UPDATED_AT },
]

export const marketWatchlistsFixture: Watchlist[] = [
  {
    id: 'watchlist', kind: 'private', name: 'Watchlist',
    symbols: ['NVDA', 'SPCX', 'META', 'BE', 'INTC', 'SPY', 'QQQ', 'IWM', 'TSLA', 'AAPL', 'AMD'],
  },
]

const catalysts: Catalyst[] = [
  { id: 'tastytrade:NVDA:earnings', symbol: 'NVDA', kind: 'earnings', title: 'NVDA earnings', date: '2026-08-26', timing: 'after-hours', confidence: 'estimated', source: 'tastytrade market metrics', sourceUrl: 'https://developer.tastytrade.com/open-api-spec/market-metrics/', updatedAt: UPDATED_AT },
  { id: 'tastytrade:TSLA:earnings', symbol: 'TSLA', kind: 'earnings', title: 'TSLA earnings', date: '2026-10-21', timing: 'after-hours', confidence: 'estimated', source: 'tastytrade market metrics', sourceUrl: 'https://developer.tastytrade.com/open-api-spec/market-metrics/', updatedAt: UPDATED_AT },
  { id: 'tastytrade:AAPL:earnings', symbol: 'AAPL', kind: 'earnings', title: 'AAPL earnings', date: '2026-10-29', timing: 'after-hours', confidence: 'estimated', source: 'tastytrade market metrics', sourceUrl: 'https://developer.tastytrade.com/open-api-spec/market-metrics/', updatedAt: UPDATED_AT },
]

const research: ResearchBrief = {
  id: 'brief-2026-08-13',
  publishedAt: '2026-08-13T13:35:00.000Z',
  title: 'Calm index tape, expensive single-name stories',
  summary: 'Index volatility remains subdued while event premium concentrates in semiconductors and high-beta growth.',
  regime: 'Selective long vol',
  regimeDetail: 'Cheap index protection · rich event volatility',
  marketMovers: [{
    symbol: 'PLTR', name: 'Palantir Technologies', category: 'gainer', price: 184.27,
    changePercent: 8.41, volume: 79_200_000, averageVolume3Month: 42_100_000,
    headline: 'Contract news may be driving the volume spike',
    description: 'Palantir rose on unusually heavy volume. A newly reported contract is a possible driver, though the headline alone does not prove causation.',
    sources: [{ label: 'Reuters · Palantir wins new contract', url: 'https://www.reuters.com/technology/palantir-contract' }],
  }],
  ideas: [
    { symbol: 'NVDA', direction: 'bullish', headline: 'Demand checks keep the AI capex thesis alive', description: 'Channel discussion points to durable accelerator demand. Expensive premium argues for patience and strict sizing.', play: 'NVDA 205c 10/16', risk: 'A guide-down or capex pause would break the demand thesis.', sources: [] },
  ],
  sources: [{ label: 'tastytrade market metrics', url: 'https://developer.tastytrade.com/open-api-spec/market-metrics/' }],
}

export function marketSnapshotFixture(): MarketSnapshot {
  return structuredClone({
    source: 'tastytrade',
    syncedAt: UPDATED_AT,
    marketState: 'open',
    watchlists: marketWatchlistsFixture,
    tickers: marketTickersFixture,
    catalysts,
    research,
  })
}
