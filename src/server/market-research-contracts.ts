import { type Static, Type } from 'typebox'

import { EquitySymbolType } from '../domain/instrument'
import { ISO_DATE_PATTERN } from '../domain/iso-date'

/**
 * Provider rows are the allocation boundary; returned rows and study count are
 * smaller model-context budgets. Study periods share the provider-row ceiling so
 * they cannot create sparse arrays larger than any accepted input series.
 */
export const MAX_PRICE_HISTORY_PROVIDER_ROWS = 4_000
export const MAX_PRICE_HISTORY_RETURNED_ROWS = 250
export const MAX_PRICE_STUDIES = 5
export const MAX_PRICE_STUDY_PERIOD = MAX_PRICE_HISTORY_PROVIDER_ROWS

const ScalarStudyParameters = Type.Object({
  kind: Type.Union([Type.Literal('SMA'), Type.Literal('EMA'), Type.Literal('RSI')]),
  period: Type.Optional(Type.Integer({ maximum: MAX_PRICE_STUDY_PERIOD, minimum: 2 })),
}, { additionalProperties: false })

const BollingerStudyParameters = Type.Object({
  kind: Type.Literal('BBANDS'),
  period: Type.Optional(Type.Integer({ maximum: MAX_PRICE_STUDY_PERIOD, minimum: 2 })),
  standardDeviations: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
}, { additionalProperties: false })

const MacdStudyParameters = Type.Object({
  fastPeriod: Type.Optional(Type.Integer({ maximum: MAX_PRICE_STUDY_PERIOD, minimum: 2 })),
  kind: Type.Literal('MACD'),
  signalPeriod: Type.Optional(Type.Integer({ maximum: MAX_PRICE_STUDY_PERIOD, minimum: 2 })),
  slowPeriod: Type.Optional(Type.Integer({ maximum: MAX_PRICE_STUDY_PERIOD, minimum: 3 })),
}, { additionalProperties: false })

const PriceStudyParameters = Type.Union([
  ScalarStudyParameters,
  BollingerStudyParameters,
  MacdStudyParameters,
])

export const PriceHistoryReadParameters = Type.Object({
  endDate: Type.Optional(Type.String({
    description: 'Inclusive end date in YYYY-MM-DD form. Defaults to today.',
    pattern: ISO_DATE_PATTERN,
  })),
  interval: Type.Optional(Type.Union([
    Type.Literal('1d'), Type.Literal('1wk'), Type.Literal('1mo'),
  ], { description: 'Daily by default.' })),
  limit: Type.Optional(Type.Integer({
    description: 'Most recent rows to return. Defaults to 120.',
    maximum: MAX_PRICE_HISTORY_RETURNED_ROWS,
    minimum: 1,
  })),
  startDate: Type.Optional(Type.String({
    description: 'Start date in YYYY-MM-DD form. Defaults to one year before endDate.',
    pattern: ISO_DATE_PATTERN,
  })),
  studies: Type.Optional(Type.Array(PriceStudyParameters, {
    description: 'Optional studies calculated from adjusted closes. Defaults: period 14; MACD 12/26/9; Bollinger deviations 2.',
    maxItems: MAX_PRICE_STUDIES,
  })),
  symbol: EquitySymbolType,
}, { additionalProperties: false })

export type StudyInput = Static<typeof PriceStudyParameters>
export type PriceHistoryReadInput = Static<typeof PriceHistoryReadParameters>

export type PriceHistoryRow = {
  adjustedClose: number
  close: number
  date: string
  high: number
  low: number
  open: number
  volume: number
}

type ScalarStudyPoint = { date: string; value: number | null }
type MacdStudyPoint = {
  date: string
  histogram: number | null
  macd: number | null
  signal: number | null
}
type BollingerStudyPoint = {
  date: string
  lower: number | null
  middle: number | null
  upper: number | null
}

export type PriceStudyResult =
  | { kind: 'SMA' | 'EMA' | 'RSI'; period: number; points: ScalarStudyPoint[] }
  | { kind: 'BBANDS'; period: number; points: BollingerStudyPoint[]; standardDeviations: number }
  | {
    fastPeriod: number
    kind: 'MACD'
    points: MacdStudyPoint[]
    signalPeriod: number
    slowPeriod: number
  }

export type PriceHistoryReadResult = {
  adjustment: 'adjusted-close'
  adjustmentMethodology: string
  currency: string
  dataAsOf: string
  delay: 'end-of-day'
  exchange: string
  fetchedAt: string
  interval: '1d' | '1mo' | '1wk'
  name?: string
  prices: PriceHistoryRow[]
  requestedRange: { endDate: string; startDate: string }
  skippedRowCount: number
  provider: string
  sourceUrl: string
  studies: PriceStudyResult[]
  studyPriceField: 'adjustedClose'
  symbol: string
  totalValidRowCount: number
  truncated: boolean
}

type ProviderPriceHistory = {
  adjustmentMethodology: string
  currency: string
  delay: 'end-of-day'
  exchange: string
  name?: string
  prices: PriceHistoryRow[]
  provider: string
  skippedRowCount: number
  sourceUrl: string
  symbol: string
}

export type PriceHistoryProvider = {
  readDaily(symbol: string, range: { endDate: string; startDate: string }): Promise<ProviderPriceHistory>
}
