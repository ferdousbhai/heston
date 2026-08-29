import { Type } from '@earendil-works/pi-ai'

import { EQUITY_SYMBOL_PATTERN, EQUITY_SYMBOL_REGEX } from '../domain/instrument'

export type HistoryKind = 'orders' | 'transactions'
export type TransactionType = 'Money Movement' | 'Trade'

export const MAX_HISTORY_DAYS = 365
export const MAX_HISTORY_ITEMS = 50
export const MAX_HISTORY_OFFSET = 1_000
export const MAX_MARKET_SYMBOLS = 20
export const MAX_SEARCH_RESULTS = 20
export const MAX_SEARCH_ROWS = 200
export const MAX_CHAIN_ROWS = 50_000
export const MAX_OPTION_EXPIRATIONS = 12
export const MAX_OPTION_CONTRACTS = 60
export const EQUITY_SYMBOL = EQUITY_SYMBOL_REGEX
/**
 * Deliberately wider than an equity symbol: broker history may be filtered by a futures
 * underlying, which tastytrade writes with a leading `/` (`/ES`). Equity-only inputs use
 * `EQUITY_SYMBOL_PATTERN`.
 */
export const UNDERLYING_SYMBOL = /^\/?[A-Z0-9.]{1,31}$/
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export const AccountHistoryReadParameters = Type.Object({
  days: Type.Optional(Type.Integer({
    description: 'Calendar-day lookback. Defaults to 90 for transactions and 7 for orders.',
    maximum: MAX_HISTORY_DAYS,
    minimum: 0,
  })),
  limit: Type.Optional(Type.Integer({
    description: 'Maximum rows to return. Defaults to 25.',
    maximum: MAX_HISTORY_ITEMS,
    minimum: 1,
  })),
  pageOffset: Type.Optional(Type.Integer({
    description: 'Zero-based broker page offset. Defaults to 0.',
    maximum: MAX_HISTORY_OFFSET,
    minimum: 0,
  })),
  transactionType: Type.Optional(Type.Union([
    Type.Literal('Trade'),
    Type.Literal('Money Movement'),
  ], { description: 'Transactions only: optionally restrict to trades or cash movements.' })),
  type: Type.Union([Type.Literal('transactions'), Type.Literal('orders')]),
  underlyingSymbol: Type.Optional(Type.String({
    description: 'Exact underlying equity or futures symbol.',
    maxLength: 32,
    pattern: '^\\/?[A-Z0-9.]{1,31}$',
  })),
}, { additionalProperties: false })

export const MarketMetricsReadParameters = Type.Object({
  symbols: Type.Array(Type.String({ pattern: EQUITY_SYMBOL_PATTERN }), {
    description: 'One to twenty exact equity ticker symbols.',
    maxItems: MAX_MARKET_SYMBOLS,
    minItems: 1,
  }),
}, { additionalProperties: false })

export const MarketStatusReadParameters = Type.Object({}, { additionalProperties: false })

export const SymbolSearchParameters = Type.Object({
  limit: Type.Optional(Type.Integer({ maximum: MAX_SEARCH_RESULTS, minimum: 1 })),
  query: Type.String({
    description: 'Ticker or company-name fragment.',
    maxLength: 64,
    minLength: 1,
    pattern: '^(?=.*\\S)[\\x20-\\x7E]+$',
  }),
}, { additionalProperties: false })

export const OptionContractFindParameters = Type.Object({
  expiry: Type.Optional(Type.String({
    description: 'Exact expiration date in YYYY-MM-DD form.',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  })),
  nearStrike: Type.Optional(Type.Number({
    description: 'Return listed contracts nearest this target strike without requiring an exact match.',
    exclusiveMinimum: 0,
    maximum: 1_000_000,
  })),
  optionType: Type.Optional(Type.Union([Type.Literal('C'), Type.Literal('P')])),
  strike: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 1_000_000 })),
  underlying: Type.String({ description: 'Exact equity ticker.', pattern: EQUITY_SYMBOL_PATTERN }),
}, { additionalProperties: false })

export const InstrumentQuoteReadParameters = Type.Object({
  contracts: Type.Optional(Type.Array(Type.Object({
    expiry: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    optionType: Type.Union([Type.Literal('C'), Type.Literal('P')]),
    strike: Type.Number({ exclusiveMinimum: 0, maximum: 1_000_000 }),
    underlying: Type.String({ pattern: EQUITY_SYMBOL_PATTERN }),
  }, { additionalProperties: false }), { maxItems: 10, minItems: 1 })),
  symbols: Type.Optional(Type.Array(Type.String({ pattern: EQUITY_SYMBOL_PATTERN }), {
    maxItems: 10,
    minItems: 1,
  })),
}, { additionalProperties: false })

export type CompactTransaction = {
  action?: string
  id: string
  instrumentType?: string
  netValue?: number
  occurredAt: string
  orderId?: string
  price?: number
  quantity?: number
  symbol?: string
  transactionSubType?: string
  transactionType: string
  underlyingSymbol?: string
  value?: number
}

export type CompactOrderLeg = {
  action: string
  instrumentType: string
  quantity: number
  remainingQuantity?: number
  symbol: string
}

export type CompactOrder = {
  id: string
  legs: CompactOrderLeg[]
  orderType: string
  price?: number
  priceEffect?: string
  receivedAt?: string
  rejectReason?: string
  size?: number
  status: string
  timeInForce: string
  underlyingInstrumentType: string
  underlyingSymbol: string
  updatedAt: string
}

export type AccountHistoryReadResult = {
  asOf: string
  days: number
  items: CompactOrder[] | CompactTransaction[]
  limit: number
  pageOffset: number
  returnedItemCount: number
  totalItemCount?: number
  truncated: boolean
  type: HistoryKind
  source: 'tastytrade'
}

export type CompactMarketMetric = {
  beta?: number
  earningsDate?: string
  earningsEstimated?: boolean
  earningsPerShare?: number
  earningsTimeOfDay?: string
  historicalVolatility30Day?: number
  impliedHistoricalVolatility30DayDifference?: number
  impliedVolatility30Day?: number
  impliedVolatilityIndex?: number
  impliedVolatilityPercentile?: number
  impliedVolatilityRank?: number
  liquidityRank?: number
  liquidityRating?: number
  liquidityValue?: number
  marketCap?: number
  priceEarningsRatio?: number
  symbol: string
  updatedAt?: string
}

export type MarketMetricsReadResult = {
  asOf: string
  metrics: CompactMarketMetric[]
  missingSymbols: string[]
  requestedSymbols: string[]
  truncated: false
  source: 'tastytrade'
  volatilityUnit: 'percentage_points'
}

export type MarketStatusReadResult = {
  asOf: string
  closesAt?: string
  extendedClosesAt?: string
  instrumentCollection?: string
  nextOpenAt?: string
  opensAt?: string
  previousCloseAt?: string
  startsAt?: string
  state: string
  truncated: false
  source: 'tastytrade'
}

export type SymbolSearchItem = {
  description: string
  hasOptions?: boolean
  instrumentType?: string
  listedMarket?: string
  symbol: string
}

export type SymbolSearchResult = {
  asOf: string
  query: string
  results: SymbolSearchItem[]
  returnedResultCount: number
  totalResultCount: number
  truncated: boolean
  source: 'tastytrade'
}

export type CompactOptionContract = {
  expirationDate: string
  isClosingOnly?: boolean
  optionType: 'C' | 'P'
  sharesPerContract: number
  streamerSymbol?: string
  strikePrice: number
  symbol: string
}

export type OptionContractFindResult = {
  asOf: string
  contracts: CompactOptionContract[]
  expirationDates: string[]
  filters: { expiry?: string; nearStrike?: number; optionType?: 'C' | 'P'; strike?: number }
  returnedContractCount: number
  returnedExpirationCount: number
  totalContractCount: number
  totalExpirationCount: number
  truncated: boolean
  underlying: string
  source: 'tastytrade'
  mode: 'contracts' | 'expirations'
}

export type InstrumentQuoteReadResult = {
  asOf: string
  quotes: Array<{
    ask: number
    askSize?: number
    bid: number
    bidSize?: number
    instrumentType: 'Equity' | 'Equity Option'
    mid: number
    observedAt: string
    symbol: string
    underlying?: string
  }>
  source: 'tastytrade-rest-market-data'
}
