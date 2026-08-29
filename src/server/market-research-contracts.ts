export type StudyInput =
  | { kind: 'SMA' | 'EMA' | 'RSI'; period?: number }
  | { kind: 'BBANDS'; period?: number; standardDeviations?: number }
  | { fastPeriod?: number; kind: 'MACD'; signalPeriod?: number; slowPeriod?: number }

/**
 * Provider rows are the allocation boundary; returned rows and study count are
 * smaller model-context budgets. Study periods share the provider-row ceiling so
 * they cannot create sparse arrays larger than any accepted input series.
 */
export const MAX_PRICE_HISTORY_PROVIDER_ROWS = 4_000
export const MAX_PRICE_HISTORY_RETURNED_ROWS = 250
export const MAX_PRICE_STUDIES = 5
export const MAX_PRICE_STUDY_PERIOD = MAX_PRICE_HISTORY_PROVIDER_ROWS

export type PriceHistoryReadInput = {
  endDate?: string
  interval?: '1d' | '1mo' | '1wk'
  limit?: number
  startDate?: string
  studies?: StudyInput[]
  symbol: string
}

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
