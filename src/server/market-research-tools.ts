import { Type } from '@earendil-works/pi-ai'
import { type AgentTool } from '@earendil-works/pi-agent-core'
import createYahooFinance from 'yahoo-finance2/createYahooFinance'
import quoteSummary, {
  type QuoteSummaryResult,
} from 'yahoo-finance2/modules/quoteSummary'

import { marketDate } from '../domain/catalyst'
import { readBoundedText } from './bounded-response'
import { type AppEnv } from './env'
import { createFmpClient, type FmpClient, ResearchProviderError } from './fmp'

const EQUITY_SYMBOL = /^[A-Z][A-Z0-9.]{0,7}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const MAX_YAHOO_RESPONSE_BYTES = 2_000_000
const YAHOO_TIMEOUT_MS = 12_000
const MAX_HISTORY_DAYS = 10 * 366
const MAX_HISTORY_ROWS = 250
const MAX_RAW_HISTORY_ROWS = 4_000
const MAX_PROFILE_CHARS = 1_600
const MAX_FILINGS = 8
const MAX_STUDIES = 5

const ResearchYahooFinance = createYahooFinance({ modules: { quoteSummary } })

type StudyInput =
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

export type CompanyFundamentalsReadResult = {
  company: {
    analystEstimates?: Array<{
      endDate?: string
      epsAverage?: number
      epsGrowth?: number
      epsRevisionsDown30Days?: number
      epsRevisionsUp30Days?: number
      numberOfEpsAnalysts?: number
      numberOfRevenueAnalysts?: number
      period: string
      revenueAverage?: number
      revenueGrowth?: number
    }>
    financials?: {
      currency?: string
      currentRatio?: number
      debtToEquity?: number
      ebitda?: number
      freeCashFlow?: number
      grossMargin?: number
      operatingCashFlow?: number
      operatingMargin?: number
      profitMargin?: number
      quickRatio?: number
      returnOnAssets?: number
      returnOnEquity?: number
      revenueGrowth?: number
      earningsGrowth?: number
      totalCash?: number
      totalDebt?: number
      totalRevenue?: number
    }
    filings: Array<{ date: string; title: string; type: string; url: string }>
    marketDataObservedAt?: string
    name: string
    ownership?: {
      insidersPercentHeld?: number
      institutionsCount?: number
      institutionsFloatPercentHeld?: number
      institutionsPercentHeld?: number
    }
    profile?: {
      businessSummary?: string
      country?: string
      fullTimeEmployees?: number
      industry?: string
      investorRelationsUrl?: string
      sector?: string
      website?: string
    }
    symbol: string
    valuation?: {
      enterpriseToEbitda?: number
      enterpriseToRevenue?: number
      enterpriseValue?: number
      forwardEarningsPerShare?: number
      forwardPriceEarnings?: number
      marketCapitalization?: number
      priceToBook?: number
      priceToSalesTrailing12Months?: number
      trailingEarningsPerShare?: number
      trailingPriceEarnings?: number
    }
  }
  fetchedAt: string
  missingSections: string[]
  source: 'yahoo-finance-quote-summary'
  sourceUrl: string
  truncated: boolean
  warning: string
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

export type CompanyFundamentalsProvider = {
  read(symbol: string, now: Date): Promise<CompanyFundamentalsReadResult>
}

export type ProviderPriceHistory = {
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

export type MarketResearchProviders = {
  companyFundamentals: CompanyFundamentalsProvider
  priceHistory: PriceHistoryProvider
}

type ResearchYahooClient = {
  quoteSummary(symbol: string, options: {
    modules: Array<
      | 'defaultKeyStatistics'
      | 'earningsTrend'
      | 'financialData'
      | 'majorHoldersBreakdown'
      | 'price'
      | 'secFilings'
      | 'summaryDetail'
      | 'summaryProfile'
    >
  }): Promise<QuoteSummaryResult>
}

export const CompanyFundamentalsReadParameters = Type.Object({
  symbol: Type.String({
    description: 'One exact US equity ticker, using tastytrade dot notation where applicable.',
    pattern: '^[A-Z][A-Z0-9.]{0,7}$',
  }),
}, { additionalProperties: false })

const ScalarStudyParameters = Type.Object({
  kind: Type.Union([Type.Literal('SMA'), Type.Literal('EMA'), Type.Literal('RSI')]),
  period: Type.Optional(Type.Integer({ maximum: 200, minimum: 2 })),
}, { additionalProperties: false })

const BollingerStudyParameters = Type.Object({
  kind: Type.Literal('BBANDS'),
  period: Type.Optional(Type.Integer({ maximum: 200, minimum: 2 })),
  standardDeviations: Type.Optional(Type.Number({ maximum: 5, minimum: 0.1 })),
}, { additionalProperties: false })

const MacdStudyParameters = Type.Object({
  fastPeriod: Type.Optional(Type.Integer({ maximum: 100, minimum: 2 })),
  kind: Type.Literal('MACD'),
  signalPeriod: Type.Optional(Type.Integer({ maximum: 100, minimum: 2 })),
  slowPeriod: Type.Optional(Type.Integer({ maximum: 200, minimum: 3 })),
}, { additionalProperties: false })

export const PriceHistoryReadParameters = Type.Object({
  endDate: Type.Optional(Type.String({
    description: 'Inclusive end date in YYYY-MM-DD form. Defaults to today.',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  })),
  interval: Type.Optional(Type.Union([
    Type.Literal('1d'), Type.Literal('1wk'), Type.Literal('1mo'),
  ], { description: 'Daily by default.' })),
  limit: Type.Optional(Type.Integer({
    description: 'Most recent rows to return. Defaults to 120.',
    maximum: MAX_HISTORY_ROWS,
    minimum: 1,
  })),
  startDate: Type.Optional(Type.String({
    description: 'Start date in YYYY-MM-DD form. Defaults to one year before endDate.',
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  })),
  studies: Type.Optional(Type.Array(Type.Union([
    ScalarStudyParameters, BollingerStudyParameters, MacdStudyParameters,
  ]), {
    description: 'Optional studies calculated from adjusted closes. Defaults: period 14; MACD 12/26/9; Bollinger deviations 2.',
    maxItems: MAX_STUDIES,
  })),
  symbol: Type.String({ pattern: '^[A-Z][A-Z0-9.]{0,7}$' }),
}, { additionalProperties: false })

function dateString(value: Date | null | undefined): string | undefined {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : undefined
}

function timestamp(value: Date | null | undefined): string | undefined {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : undefined
}

function finite(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function compactObject<T extends Record<string, unknown>>(value: T): T | undefined {
  return Object.values(value).some((entry) => entry !== undefined) ? value : undefined
}

function safeHttpsUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function normalizeSymbol(value: string): string {
  const symbol = value.trim().toUpperCase()
  if (!EQUITY_SYMBOL.test(symbol)) throw new Error('Market research symbol is invalid.')
  return symbol
}

function yahooSymbol(symbol: string): string {
  return symbol.replaceAll('.', '-')
}

function boundedYahooFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(YAHOO_TIMEOUT_MS)
    const signal = init?.signal ? AbortSignal.any([timeout, init.signal]) : timeout
    const response = await fetcher(input, { ...init, signal })
    const body = await readBoundedText(response, MAX_YAHOO_RESPONSE_BYTES, 'YahooFinance')
    const emptyBodyStatus = response.status === 101
      || response.status === 204
      || response.status === 205
      || response.status === 304
    return new Response(emptyBodyStatus ? null : body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    })
  }
}

function createYahooClient(fetcher: typeof fetch = fetch): ResearchYahooClient {
  return new ResearchYahooFinance({
    fetch: boundedYahooFetch(fetcher),
    queue: { concurrency: 2 },
    suppressNotices: ['yahooSurvey'],
    validation: { logErrors: false, logOptionsErrors: false },
    versionCheck: false,
  })
}

function compactFundamentals(
  raw: QuoteSummaryResult,
  requestedSymbol: string,
  providerSymbol: string,
  now: Date,
): CompanyFundamentalsReadResult {
  const price = raw.price
  if (!price || price.symbol !== providerSymbol || price.quoteType !== 'EQUITY') {
    throw new Error('Yahoo Finance fundamentals returned a mismatched or unsupported instrument.')
  }
  const profile = raw.summaryProfile
  const financial = raw.financialData
  const stats = raw.defaultKeyStatistics
  const detail = raw.summaryDetail
  const holders = raw.majorHoldersBreakdown
  const rawFilings = raw.secFilings?.filings ?? []
  const filings = rawFilings.flatMap((filing) => {
    const url = safeHttpsUrl(filing.edgarUrl)
    if (!url || !validDate(filing.date)) return []
    return [{
      date: filing.date,
      title: filing.title.slice(0, 180),
      type: filing.type,
      url,
    }]
  }).slice(0, MAX_FILINGS)
  const businessSummary = profile?.longBusinessSummary?.trim()
  const sourceUrl = `https://finance.yahoo.com/quote/${encodeURIComponent(providerSymbol)}`

  const result: CompanyFundamentalsReadResult = {
    company: {
      analystEstimates: raw.earningsTrend?.trend.slice(0, 4).map((trend) => ({
        endDate: dateString(trend.endDate),
        epsAverage: finite(trend.earningsEstimate.avg),
        epsGrowth: finite(trend.earningsEstimate.growth),
        epsRevisionsDown30Days: finite(trend.epsRevisions.downLast30days),
        epsRevisionsUp30Days: finite(trend.epsRevisions.upLast30days),
        numberOfEpsAnalysts: finite(trend.earningsEstimate.numberOfAnalysts),
        numberOfRevenueAnalysts: finite(trend.revenueEstimate.numberOfAnalysts),
        period: trend.period,
        revenueAverage: finite(trend.revenueEstimate.avg),
        revenueGrowth: finite(trend.revenueEstimate.growth),
      })),
      financials: financial ? compactObject({
        currency: financial.financialCurrency ?? undefined,
        currentRatio: finite(financial.currentRatio),
        debtToEquity: finite(financial.debtToEquity),
        ebitda: finite(financial.ebitda),
        earningsGrowth: finite(financial.earningsGrowth),
        freeCashFlow: finite(financial.freeCashflow),
        grossMargin: finite(financial.grossMargins),
        operatingCashFlow: finite(financial.operatingCashflow),
        operatingMargin: finite(financial.operatingMargins),
        profitMargin: finite(financial.profitMargins),
        quickRatio: finite(financial.quickRatio),
        returnOnAssets: finite(financial.returnOnAssets),
        returnOnEquity: finite(financial.returnOnEquity),
        revenueGrowth: finite(financial.revenueGrowth),
        totalCash: finite(financial.totalCash),
        totalDebt: finite(financial.totalDebt),
        totalRevenue: finite(financial.totalRevenue),
      }) : undefined,
      filings,
      marketDataObservedAt: timestamp(price.regularMarketTime),
      name: price.longName ?? price.shortName ?? requestedSymbol,
      ownership: holders ? compactObject({
        insidersPercentHeld: finite(holders.insidersPercentHeld),
        institutionsCount: finite(holders.institutionsCount),
        institutionsFloatPercentHeld: finite(holders.institutionsFloatPercentHeld),
        institutionsPercentHeld: finite(holders.institutionsPercentHeld),
      }) : undefined,
      profile: profile ? compactObject({
        businessSummary: businessSummary
          ? `${businessSummary.slice(0, MAX_PROFILE_CHARS)}${businessSummary.length > MAX_PROFILE_CHARS ? '…' : ''}`
          : undefined,
        country: profile.country,
        fullTimeEmployees: finite(profile.fullTimeEmployees),
        industry: profile.industry,
        investorRelationsUrl: safeHttpsUrl(profile.irWebsite),
        sector: profile.sector,
        website: safeHttpsUrl(profile.website),
      }) : undefined,
      symbol: requestedSymbol,
      valuation: (stats ?? detail) ? compactObject({
        enterpriseToEbitda: finite(stats?.enterpriseToEbitda),
        enterpriseToRevenue: finite(stats?.enterpriseToRevenue),
        enterpriseValue: finite(stats?.enterpriseValue),
        forwardEarningsPerShare: finite(stats?.forwardEps),
        forwardPriceEarnings: finite(stats?.forwardPE ?? detail?.forwardPE),
        marketCapitalization: finite(price.marketCap ?? detail?.marketCap),
        priceToBook: finite(stats?.priceToBook),
        priceToSalesTrailing12Months: finite(detail?.priceToSalesTrailing12Months),
        trailingEarningsPerShare: finite(stats?.trailingEps),
        trailingPriceEarnings: finite(detail?.trailingPE),
      }) : undefined,
    },
    fetchedAt: now.toISOString(),
    missingSections: [],
    source: 'yahoo-finance-quote-summary',
    sourceUrl,
    truncated: rawFilings.length > filings.length || Boolean(businessSummary && businessSummary.length > MAX_PROFILE_CHARS),
    warning: 'Secondary-source fundamentals and analyst estimates; verify material claims against primary filings before increasing risk.',
  }
  result.missingSections = ([
    ['profile', result.company.profile],
    ['financials', result.company.financials],
    ['valuation', result.company.valuation],
    ['ownership', result.company.ownership],
    ['analystEstimates', result.company.analystEstimates?.length],
    ['filings', result.company.filings.length],
  ] as const).flatMap(([name, value]) => value ? [] : [name])
  return result
}

export function createYahooFundamentalsProvider(
  client: ResearchYahooClient = createYahooClient(),
): CompanyFundamentalsProvider {
  return {
    async read(symbol, now) {
      const providerSymbol = yahooSymbol(symbol)
      let raw: QuoteSummaryResult
      try {
        raw = await client.quoteSummary(providerSymbol, { modules: [
          'price',
          'summaryProfile',
          'financialData',
          'defaultKeyStatistics',
          'earningsTrend',
          'majorHoldersBreakdown',
          'secFilings',
          'summaryDetail',
        ] })
      } catch {
        throw new Error('Company fundamentals provider is unavailable.')
      }
      return compactFundamentals(raw, symbol, providerSymbol, now)
    },
  }
}

export async function readCompanyFundamentals(
  requestedSymbol: string,
  now = new Date(),
  provider: CompanyFundamentalsProvider = createYahooFundamentalsProvider(),
): Promise<CompanyFundamentalsReadResult> {
  return provider.read(normalizeSymbol(requestedSymbol), now)
}

type FmpRawHistoryRow = Omit<PriceHistoryRow, 'adjustedClose'> & { symbol: string }
type FmpAdjustedHistoryRow = { adjustedClose: number; date: string; symbol: string }

function invalidFmpHistory(): never {
  throw new ResearchProviderError('invalid-response', 'fmp')
}

function fmpRows(payload: unknown): unknown[] {
  if (!Array.isArray(payload) || payload.length > MAX_RAW_HISTORY_ROWS) return invalidFmpHistory()
  return payload
}

function fmpRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function fmpText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function fmpNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function fmpSymbol(record: Record<string, unknown>, requestedSymbol: string): string | undefined {
  const symbol = fmpText(record.symbol)?.toUpperCase()
  if (symbol && symbol !== requestedSymbol) return invalidFmpHistory()
  return symbol
}

function normalizeFmpRawHistoryRow(value: unknown, requestedSymbol: string): FmpRawHistoryRow | undefined {
  const record = fmpRecord(value)
  if (!record) return undefined
  const symbol = fmpSymbol(record, requestedSymbol)
  const date = fmpText(record.date)
  const open = fmpNumber(record.open)
  const high = fmpNumber(record.high)
  const low = fmpNumber(record.low)
  const close = fmpNumber(record.close)
  const volume = fmpNumber(record.volume)
  if (!symbol || !date || !validDate(date) || open === undefined || high === undefined
    || low === undefined || close === undefined || volume === undefined || volume < 0
    || low > high || open < 0 || close < 0) return undefined
  return { close, date, high, low, open, symbol, volume }
}

function normalizeFmpAdjustedHistoryRow(value: unknown, requestedSymbol: string): FmpAdjustedHistoryRow | undefined {
  const record = fmpRecord(value)
  if (!record) return undefined
  const symbol = fmpSymbol(record, requestedSymbol)
  const date = fmpText(record.date)
  const adjustedClose = fmpNumber(record.adjClose)
  if (!symbol || !date || !validDate(date) || adjustedClose === undefined || adjustedClose < 0) return undefined
  return { adjustedClose, date, symbol }
}

function uniqueHistoryRows<T extends { date: string }>(rows: T[]): T[] {
  if (new Set(rows.map((row) => row.date)).size !== rows.length) return invalidFmpHistory()
  return rows
}

export function createFmpPriceHistoryProvider(
  env: AppEnv,
  client: FmpClient = createFmpClient(env),
): PriceHistoryProvider {
  return {
    async readDaily(symbol, range) {
      const parameters = { from: range.startDate, symbol, to: range.endDate }
      const [rawPayload, adjustedPayload] = await Promise.all([
        client.get('/historical-price-eod/non-split-adjusted', parameters),
        client.get('/historical-price-eod/dividend-adjusted', parameters),
      ])
      const rawPayloadRows = fmpRows(rawPayload)
      const adjustedPayloadRows = fmpRows(adjustedPayload)
      const rawRows = uniqueHistoryRows(rawPayloadRows.flatMap((value) => {
        const row = normalizeFmpRawHistoryRow(value, symbol)
        return row ? [row] : []
      }))
      const adjustedRows = uniqueHistoryRows(adjustedPayloadRows.flatMap((value) => {
        const row = normalizeFmpAdjustedHistoryRow(value, symbol)
        return row ? [row] : []
      }))
      const adjustedByDate = new Map(adjustedRows.map((row) => [row.date, row.adjustedClose]))
      const prices = rawRows.flatMap((row): PriceHistoryRow[] => {
        const adjustedClose = adjustedByDate.get(row.date)
        if (row.date < range.startDate || row.date > range.endDate || adjustedClose === undefined) return []
        const { symbol: _symbol, ...raw } = row
        return [{ ...raw, adjustedClose }]
      }).sort((left, right) => left.date.localeCompare(right.date))
      if (!prices.length) return invalidFmpHistory()

      const source = new URL('historical-price-eod/dividend-adjusted', 'https://financialmodelingprep.com/stable/')
      for (const [name, value] of Object.entries(parameters)) source.searchParams.set(name, value)
      return {
        adjustmentMethodology: 'OHLCV is unadjusted; adjustedClose is split- and dividend-adjusted by the provider.',
        currency: 'USD',
        delay: 'end-of-day',
        exchange: 'US equities EOD',
        prices,
        provider: 'financial-modeling-prep',
        skippedRowCount: rawPayloadRows.length - prices.length,
        sourceUrl: source.toString(),
        symbol,
      }
    },
  }
}

function requireInteger(value: number | undefined, fallback: number, minimum: number, maximum: number, label: string) {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label} is invalid.`)
  }
  return result
}

function scalarPoints(dates: string[], values: Array<number | null>): ScalarStudyPoint[] {
  return dates.map((date, index) => ({ date, value: values[index] ?? null }))
}

function simpleMovingAverage(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null)
  let sum = 0
  for (let index = 0; index < values.length; index++) {
    sum += values[index]!
    if (index >= period) sum -= values[index - period]!
    if (index >= period - 1) result[index] = sum / period
  }
  return result
}

function exponentialMovingAverage(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null)
  if (values.length < period) return result
  const multiplier = 2 / (period + 1)
  let previous = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  result[period - 1] = previous
  for (let index = period; index < values.length; index++) {
    previous = (values[index]! - previous) * multiplier + previous
    result[index] = previous
  }
  return result
}

function relativeStrengthIndex(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null)
  if (values.length <= period) return result
  let gains = 0
  let losses = 0
  for (let index = 1; index <= period; index++) {
    const change = values[index]! - values[index - 1]!
    gains += Math.max(0, change)
    losses += Math.max(0, -change)
  }
  let averageGain = gains / period
  let averageLoss = losses / period
  const rsi = () => averageLoss === 0
    ? averageGain === 0 ? 50 : 100
    : 100 - 100 / (1 + averageGain / averageLoss)
  result[period] = rsi()
  for (let index = period + 1; index < values.length; index++) {
    const change = values[index]! - values[index - 1]!
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period
    result[index] = rsi()
  }
  return result
}

function bollingerBands(values: number[], period: number, deviations: number): Array<{
  lower: number | null
  middle: number | null
  upper: number | null
}> {
  const middle = simpleMovingAverage(values, period)
  return values.map((_, index) => {
    if (index < period - 1) return { lower: null, middle: null, upper: null }
    const mean = middle[index]!
    const window = values.slice(index - period + 1, index + 1)
    const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period
    const width = Math.sqrt(variance) * deviations
    return { lower: mean - width, middle: mean, upper: mean + width }
  })
}

function movingAverageConvergenceDivergence(
  values: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
): Array<{ histogram: number | null; macd: number | null; signal: number | null }> {
  const fast = exponentialMovingAverage(values, fastPeriod)
  const slow = exponentialMovingAverage(values, slowPeriod)
  const macd = values.map((_, index) => fast[index] === null || slow[index] === null
    ? null
    : fast[index]! - slow[index]!)
  const firstMacdIndex = macd.findIndex((value) => value !== null)
  const signalValues = firstMacdIndex < 0
    ? []
    : exponentialMovingAverage(macd.slice(firstMacdIndex) as number[], signalPeriod)
  return macd.map((value, index) => {
    const signal = firstMacdIndex < 0 || index < firstMacdIndex
      ? null
      : signalValues[index - firstMacdIndex] ?? null
    return {
      histogram: value === null || signal === null ? null : value - signal,
      macd: value,
      signal,
    }
  })
}

function normalizeStudies(inputs: StudyInput[] | undefined): StudyInput[] {
  if (!inputs) return []
  if (!Array.isArray(inputs) || inputs.length > MAX_STUDIES) throw new Error('Price studies are invalid.')
  const seen = new Set<string>()
  return inputs.map((input) => {
    if (!input || typeof input !== 'object') throw new Error('Price studies are invalid.')
    if (input.kind === 'SMA' || input.kind === 'EMA' || input.kind === 'RSI') {
      const period = requireInteger(input.period, 14, 2, 200, `${input.kind} period`)
      const key = `${input.kind}:${period}`
      if (seen.has(key)) throw new Error('Duplicate price studies are not allowed.')
      seen.add(key)
      return { kind: input.kind, period }
    }
    if (input.kind === 'BBANDS') {
      const period = requireInteger(input.period, 14, 2, 200, 'Bollinger period')
      const standardDeviations = input.standardDeviations ?? 2
      if (!Number.isFinite(standardDeviations) || standardDeviations < 0.1 || standardDeviations > 5) {
        throw new Error('Bollinger deviations are invalid.')
      }
      const key = `${input.kind}:${period}:${standardDeviations}`
      if (seen.has(key)) throw new Error('Duplicate price studies are not allowed.')
      seen.add(key)
      return { kind: input.kind, period, standardDeviations }
    }
    if (input.kind === 'MACD') {
      const fastPeriod = requireInteger(input.fastPeriod, 12, 2, 100, 'MACD fast period')
      const slowPeriod = requireInteger(input.slowPeriod, 26, 3, 200, 'MACD slow period')
      const signalPeriod = requireInteger(input.signalPeriod, 9, 2, 100, 'MACD signal period')
      if (fastPeriod >= slowPeriod) throw new Error('MACD fast period must be less than slow period.')
      const key = `${input.kind}:${fastPeriod}:${slowPeriod}:${signalPeriod}`
      if (seen.has(key)) throw new Error('Duplicate price studies are not allowed.')
      seen.add(key)
      return { fastPeriod, kind: input.kind, signalPeriod, slowPeriod }
    }
    throw new Error('Price studies are invalid.')
  })
}

function calculateStudies(rows: PriceHistoryRow[], inputs: StudyInput[], returnedStart: number): PriceStudyResult[] {
  const dates = rows.map((row) => row.date)
  const prices = rows.map((row) => row.adjustedClose)
  return inputs.map((input): PriceStudyResult => {
    if (input.kind === 'SMA' || input.kind === 'EMA' || input.kind === 'RSI') {
      const period = input.period!
      const values = input.kind === 'SMA'
        ? simpleMovingAverage(prices, period)
        : input.kind === 'EMA'
          ? exponentialMovingAverage(prices, period)
          : relativeStrengthIndex(prices, period)
      return { kind: input.kind, period, points: scalarPoints(dates, values).slice(returnedStart) }
    }
    if (input.kind === 'BBANDS') {
      const period = input.period!
      const standardDeviations = input.standardDeviations!
      const values = bollingerBands(prices, period, standardDeviations)
      return {
        kind: input.kind,
        period,
        points: dates.map((date, index) => ({ date, ...values[index]! })).slice(returnedStart),
        standardDeviations,
      }
    }
    if (input.kind !== 'MACD') throw new Error('Price studies are invalid.')
    const fastPeriod = input.fastPeriod!
    const slowPeriod = input.slowPeriod!
    const signalPeriod = input.signalPeriod!
    const values = movingAverageConvergenceDivergence(prices, fastPeriod, slowPeriod, signalPeriod)
    return {
      fastPeriod,
      kind: input.kind,
      points: dates.map((date, index) => ({ date, ...values[index]! })).slice(returnedStart),
      signalPeriod,
      slowPeriod,
    }
  })
}

function requestedHistoryRange(input: PriceHistoryReadInput, now: Date) {
  const endDate = input.endDate ?? marketDate(now)
  if (!validDate(endDate)) throw new Error('Price history end date is invalid.')
  const startDate = input.startDate ?? shiftDate(endDate, -365)
  if (!validDate(startDate)) throw new Error('Price history start date is invalid.')
  const start = Date.parse(`${startDate}T00:00:00.000Z`)
  const end = Date.parse(`${endDate}T00:00:00.000Z`)
  if (start > end || (end - start) / 86_400_000 > MAX_HISTORY_DAYS) {
    throw new Error('Price history range is invalid or exceeds ten years.')
  }
  return { endDate, startDate }
}

function historyPeriodKey(date: string, interval: '1d' | '1mo' | '1wk'): string {
  if (interval === '1d') return date
  if (interval === '1mo') return date.slice(0, 7)
  const monday = new Date(`${date}T00:00:00.000Z`)
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  return monday.toISOString().slice(0, 10)
}

function aggregateHistory(
  rows: PriceHistoryRow[],
  interval: '1d' | '1mo' | '1wk',
): PriceHistoryRow[] {
  if (interval === '1d') return rows
  const result: PriceHistoryRow[] = []
  let key = ''
  for (const row of rows) {
    const nextKey = historyPeriodKey(row.date, interval)
    const previous = result.at(-1)
    if (!previous || key !== nextKey) {
      result.push({ ...row })
      key = nextKey
      continue
    }
    previous.adjustedClose = row.adjustedClose
    previous.close = row.close
    previous.date = row.date
    previous.high = Math.max(previous.high, row.high)
    previous.low = Math.min(previous.low, row.low)
    previous.volume += row.volume
  }
  return result
}

export async function readPriceHistory(
  input: PriceHistoryReadInput,
  provider: PriceHistoryProvider,
  now = new Date(),
): Promise<PriceHistoryReadResult> {
  const symbol = normalizeSymbol(input.symbol)
  const interval = input.interval ?? '1d'
  if (interval !== '1d' && interval !== '1wk' && interval !== '1mo') throw new Error('Price history interval is invalid.')
  const limit = requireInteger(input.limit, 120, 1, MAX_HISTORY_ROWS, 'Price history limit')
  const requestedRange = requestedHistoryRange(input, now)
  const studyInputs = normalizeStudies(input.studies)
  const providerResult = await provider.readDaily(symbol, requestedRange)
  if (providerResult.symbol !== symbol || providerResult.prices.length > MAX_RAW_HISTORY_ROWS) {
    throw new Error('Price history provider returned a mismatched or oversized response.')
  }
  const daily = [...providerResult.prices].sort((left, right) => left.date.localeCompare(right.date))
  if (!daily.length || new Set(daily.map((row) => row.date)).size !== daily.length) {
    throw new Error('Price history provider returned no usable unique rows.')
  }
  const normalized = aggregateHistory(daily, interval)
  const returnedStart = Math.max(0, normalized.length - limit)
  const prices = normalized.slice(returnedStart)
  return {
    adjustment: 'adjusted-close',
    adjustmentMethodology: providerResult.adjustmentMethodology,
    currency: providerResult.currency,
    dataAsOf: prices.at(-1)!.date,
    delay: providerResult.delay,
    exchange: providerResult.exchange,
    fetchedAt: now.toISOString(),
    interval,
    name: providerResult.name,
    prices,
    provider: providerResult.provider,
    requestedRange,
    returnedRowCount: prices.length,
    skippedRowCount: providerResult.skippedRowCount,
    source: providerResult.provider,
    sourceUrl: providerResult.sourceUrl,
    stale: false,
    studies: calculateStudies(normalized, studyInputs, returnedStart),
    studyPriceField: 'adjustedClose',
    symbol,
    totalValidRowCount: normalized.length,
    truncated: normalized.length > prices.length,
  }
}

function textResult<T>(result: T) {
  return { content: [{ text: JSON.stringify(result), type: 'text' as const }], details: result }
}

export function createCompanyFundamentalsReadTool(
  provider: CompanyFundamentalsProvider = createYahooFundamentalsProvider(),
): AgentTool<
  typeof CompanyFundamentalsReadParameters,
  CompanyFundamentalsReadResult
> {
  return {
    description: 'Read compact company profile, valuation, financial-health, ownership, analyst-estimate, and recent filing metadata for one exact equity. This is bounded secondary-source research; verify material claims against primary filings.',
    execute: async (_toolCallId, params) => textResult(await readCompanyFundamentals(params.symbol, new Date(), provider)),
    executionMode: 'sequential',
    label: 'Reading company fundamentals',
    name: 'read_company_fundamentals',
    parameters: CompanyFundamentalsReadParameters,
  }
}

export function createPriceHistoryReadTool(
  provider: PriceHistoryProvider,
): AgentTool<
  typeof PriceHistoryReadParameters,
  PriceHistoryReadResult
> {
  return {
    description: 'Read bounded dividend-adjusted daily, weekly, or monthly equity price history from a documented authenticated source, with optional SMA, EMA, RSI, MACD, or Bollinger studies calculated locally from adjusted closes. Historical and technical context is not a current executable quote or standalone edge.',
    execute: async (_toolCallId, params) => textResult(await readPriceHistory(params, provider)),
    executionMode: 'sequential',
    label: 'Reading price history',
    name: 'read_price_history',
    parameters: PriceHistoryReadParameters,
  }
}

export function createMarketResearchProviders(env: AppEnv): MarketResearchProviders {
  return {
    companyFundamentals: createYahooFundamentalsProvider(),
    priceHistory: createFmpPriceHistoryProvider(env),
  }
}

export function createMarketResearchTools(
  env: AppEnv,
  providers: MarketResearchProviders = createMarketResearchProviders(env),
) {
  return [
    createCompanyFundamentalsReadTool(providers.companyFundamentals),
    createPriceHistoryReadTool(providers.priceHistory),
  ]
}
