export type StudyInput =
  | { kind: 'SMA' | 'EMA' | 'RSI'; period?: number }
  | { kind: 'BBANDS'; period?: number; standardDeviations?: number }
  | { fastPeriod?: number; kind: 'MACD'; signalPeriod?: number; slowPeriod?: number }

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
  returnedRowCount: number
  skippedRowCount: number
  provider: string
  source: string
  sourceUrl: string
  stale: false
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
