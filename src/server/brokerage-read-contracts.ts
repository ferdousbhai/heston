import { type Static, Type } from 'typebox'

import { EquityOptionTupleSchema } from '../domain/equity-option'
import { EQUITY_SYMBOL_REGEX, ModelTextEquitySymbolType } from '../domain/instrument'
import {
  type BrokerBalances,
  type BrokerHistoryOrder,
  type BrokerHistoryTransaction,
  type BrokerId,
  type BrokerPosition,
  type BrokerWorkingOrder,
} from '../domain/broker'
import { IsoDateType } from '../domain/iso-date'
import { StringEnum } from '../domain/string-enum'
import { MAX_QUERY_LENGTH } from './symbol-search'

// These are model-context budgets, not brokerage or trading policy. Read tools expose
// pagination/truncation so the agent can make another narrow call instead of receiving
// an unbounded account, search, or option-chain payload in one turn.
export const MAX_HISTORY_ITEMS = 50
export const MAX_MARKET_SYMBOLS = 20
export const MAX_SEARCH_RESULTS = 20
export const MAX_OPTION_EXPIRATIONS = 12
export const MAX_OPTION_CONTRACTS = 60
export const MAX_QUOTE_INSTRUMENTS = 10
/**
 * One history order carries its legs inline, so the row cap alone does not bound a page: this is
 * the per-row share of the same context budget. It is far wider than any order Heston builds (at
 * most two legs) and refuses the page rather than truncating a leg list, so an order is never shown
 * with fewer legs than it has.
 */
export const MAX_HISTORY_ORDER_LEGS = 20
// Defaults for an omitted optional input, from the same context budget: a first call returns a
// useful page well inside its ceiling, and the agent pages or widens only when it needs to. The
// history windows are the reads a trader asks first -- a quarter of cash and trade activity, and
// the week of orders a working ticket or a replacement is likely to belong to.
export const DEFAULT_HISTORY_ITEMS = 25
export const DEFAULT_TRANSACTION_HISTORY_DAYS = 90
export const DEFAULT_ORDER_HISTORY_DAYS = 7
export const DEFAULT_SEARCH_RESULTS = 10
// Provider-envelope ceilings are substantially wider than returned context. They reject
// anomalous upstream fan-out before normalization allocates or processes arbitrary rows.
export const MAX_SEARCH_ROWS = 200
export const MAX_CHAIN_ROWS = 50_000
export const EQUITY_SYMBOL = EQUITY_SYMBOL_REGEX
/**
 * Deliberately wider than an equity symbol: broker history may be filtered by a futures
 * underlying, which tastytrade writes with a leading `/` (`/ES`). Equity-only inputs use
 * `EQUITY_SYMBOL_PATTERN`.
 */
export const UNDERLYING_SYMBOL = /^\/?[A-Z0-9.]{1,31}$/

/** The three reader-facing parts of the brokerage snapshot. */
export const ACCOUNT_SNAPSHOT_PARTS = ['balances', 'positions', 'orders'] as const
export type AccountSnapshotPart = (typeof ACCOUNT_SNAPSHOT_PARTS)[number]

export const AccountSnapshotReadParameters = Type.Object({
  include: Type.Optional(Type.Array(StringEnum(ACCOUNT_SNAPSHOT_PARTS), {
    description: 'Subset of the snapshot.',
    maxItems: ACCOUNT_SNAPSHOT_PARTS.length,
    minItems: 1,
    uniqueItems: true,
  })),
}, { additionalProperties: false })

export type AccountSnapshotReadInput = Static<typeof AccountSnapshotReadParameters>

export type AccountSnapshotReadResult = {
  asOf: string
  balances?: BrokerBalances
  orders?: BrokerWorkingOrder[]
  positions?: BrokerPosition[]
  source: BrokerId
}

export const AccountHistoryReadParameters = Type.Object({
  days: Type.Optional(Type.Integer({
    description: `Calendar-day lookback. Defaults to ${DEFAULT_TRANSACTION_HISTORY_DAYS} for transactions `
      + `and ${DEFAULT_ORDER_HISTORY_DAYS} for orders.`,
    minimum: 0,
  })),
  limit: Type.Optional(Type.Integer({
    description: `Maximum rows to return. Defaults to ${DEFAULT_HISTORY_ITEMS}.`,
    maximum: MAX_HISTORY_ITEMS,
    minimum: 1,
  })),
  pageOffset: Type.Optional(Type.Integer({
    description: 'Zero-based broker page offset. Defaults to 0.',
    minimum: 0,
  })),
  transactionType: Type.Optional(StringEnum(
    ['Trade', 'Money Movement'],
    { description: 'Transactions only: optionally restrict to trades or cash movements.' },
  )),
  type: StringEnum(['transactions', 'orders']),
  underlyingSymbol: Type.Optional(Type.String({
    maxLength: 32,
    pattern: UNDERLYING_SYMBOL.source,
  })),
}, { additionalProperties: false })

export const MarketMetricsReadParameters = Type.Object({
  symbols: Type.Array(ModelTextEquitySymbolType, {
    description: 'Ticker symbols; a leading $ cashtag is read as the bare symbol.',
    maxItems: MAX_MARKET_SYMBOLS,
    minItems: 1,
  }),
}, { additionalProperties: false })

/**
 * The query bound is the anonymous search's own: the two tools share the name `search_symbols`, so
 * an agent must not find one tier accepts a query the other refuses.
 */
export const SymbolSearchParameters = Type.Object({
  limit: Type.Optional(Type.Integer({
    description: `Maximum results to return. Defaults to ${DEFAULT_SEARCH_RESULTS}.`,
    maximum: MAX_SEARCH_RESULTS,
    minimum: 1,
  })),
  query: Type.String({
    description: 'Ticker or company-name fragment.',
    maxLength: MAX_QUERY_LENGTH,
    minLength: 1,
    pattern: '^(?=.*\\S)[\\x20-\\x7E]+$',
  }),
}, { additionalProperties: false })

export const OptionContractFindParameters = Type.Object({
  expiry: Type.Optional(IsoDateType),
  nearStrike: Type.Optional(Type.Number({
    description: 'Target strike; returns the nearest listed contracts.',
    exclusiveMinimum: 0,
  })),
  optionType: Type.Optional(StringEnum(['C', 'P'])),
  strike: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
  underlying: ModelTextEquitySymbolType,
}, { additionalProperties: false })

export const InstrumentQuoteReadParameters = Type.Object({
  contracts: Type.Optional(Type.Array(EquityOptionTupleSchema, {
    maxItems: MAX_QUOTE_INSTRUMENTS,
    minItems: 1,
  })),
  symbols: Type.Optional(Type.Array(ModelTextEquitySymbolType, {
    maxItems: MAX_QUOTE_INSTRUMENTS,
    minItems: 1,
  })),
}, { additionalProperties: false })

export type AccountHistoryReadInput = Static<typeof AccountHistoryReadParameters>
export type InstrumentQuoteReadInput = Static<typeof InstrumentQuoteReadParameters>
export type OptionContractFindInput = Static<typeof OptionContractFindParameters>

export type AccountHistoryReadResult = {
  asOf: string
  items: BrokerHistoryOrder[] | BrokerHistoryTransaction[]
  pageOffset: number
  totalItemCount?: number
  truncated: boolean
  source: BrokerId
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
  source: 'tastytrade'
  volatilityUnit: 'percentage_points'
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
  results: SymbolSearchItem[]
  totalResultCount: number
  truncated: boolean
  source: 'tastytrade'
}

/**
 * A contract row carries only what the caller can act on. The OCC symbol and the DXLink
 * streamer symbol are deliberately absent: every tool that takes a contract takes the tuple
 * (underlying, expiry, strike, type) and resolves those server-side, so returning them was
 * two long strings per row, sixty rows a call, that nothing could be done with.
 * Open interest and volume are the ranking fields; they come from a second market-data
 * read, not the compact chain.
 */
export type CompactOptionContract = {
  expirationDate: string
  isClosingOnly?: boolean
  openInterest?: number
  optionType: 'C' | 'P'
  sharesPerContract: number
  strikePrice: number
  volume?: number
}

type OptionContractFindBase = {
  asOf: string
  source: 'tastytrade'
}

export type OptionContractFindResult = OptionContractFindBase & (
  | { contracts: CompactOptionContract[]; mode: 'contracts'; truncated: boolean }
  | { expirationDates: string[]; mode: 'expirations'; truncated: boolean }
)

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
