import { Type } from '@earendil-works/pi-ai'
import { type AgentTool } from '@earendil-works/pi-agent-core'
import createYahooFinance from 'yahoo-finance2/createYahooFinance'
import chart, { type ChartResultArray } from 'yahoo-finance2/modules/chart'
import quoteSummary, {
  type QuoteSummaryResult,
} from 'yahoo-finance2/modules/quoteSummary'

import { marketDate } from '../domain/catalyst'
import { readBoundedText } from './bounded-response'
import {
  type CompanyFundamentalsProvider,
  type CompanyFundamentalsReadResult,
  type MarketResearchProviders,
  type PriceHistoryProvider,
  type PriceHistoryReadInput,
  type PriceHistoryReadResult,
  type PriceHistoryRow,
} from './market-research-contracts'
import { ResearchProviderError } from './research-provider'
import { textResult } from './agent-tool-result'
import { boundedInteger, calculateStudies, normalizeStudies } from './technical-studies'

export type {
  CompanyFundamentalsProvider,
  CompanyFundamentalsReadResult,
  MarketResearchProviders,
  PriceHistoryProvider,
  PriceHistoryReadInput,
  PriceHistoryReadResult,
  PriceHistoryRow,
} from './market-research-contracts'

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

/**
 * Yahoo is intentionally a credential-free, delayed secondary context source.
 * It never supplies executable quotes or contracts; tastytrade remains the order
 * boundary, and every result below carries provider, delay, and adjustment labels.
 */
const ResearchYahooFinance = createYahooFinance({ modules: { chart, quoteSummary } })

type ResearchYahooClient = {
  chart(symbol: string, options: {
    interval: '1d'
    period1: string
    period2: string
  }): Promise<ChartResultArray>
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

const CompanyFundamentalsReadParameters = Type.Object({
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

const PriceHistoryReadParameters = Type.Object({
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
  return value !== null && value !== undefined && Number.isFinite(value) ? value : undefined
}

function compactObject<T extends object>(value: T): T | undefined {
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
  client: Pick<ResearchYahooClient, 'quoteSummary'> = createYahooClient(),
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

function invalidHistory(): never {
  throw new ResearchProviderError('invalid-response', 'yahoo')
}

/** `dateString` already round-trips through `toISOString`, so only the expanded-year form can slip past. */
function historyDate(value: Date): string | undefined {
  const date = dateString(value)
  return date && ISO_DATE.test(date) ? date : undefined
}

/**
 * Yahoo daily bars are split-adjusted OHLCV with `adjclose` carrying the additional dividend
 * adjustment, so unlike a two-endpoint provider there is no cross-payload date reconciliation.
 * Rows missing any field are skipped rather than fatal; duplicate dates are fatal because they
 * would silently corrupt local aggregation and studies.
 */
function normalizeChartQuote(quote: ChartResultArray['quotes'][number]): PriceHistoryRow | undefined {
  const date = historyDate(quote.date)
  const open = finite(quote.open)
  const high = finite(quote.high)
  const low = finite(quote.low)
  const close = finite(quote.close)
  const volume = finite(quote.volume)
  if (date === undefined || open === undefined || high === undefined
    || low === undefined || close === undefined || volume === undefined) return undefined
  const adjustedClose = finite(quote.adjclose) ?? close
  if (volume < 0 || low > high || open < 0 || close < 0 || adjustedClose < 0) return undefined
  return { adjustedClose, close, date, high, low, open, volume }
}

export function createYahooPriceHistoryProvider(
  client: Pick<ResearchYahooClient, 'chart'> = createYahooClient(),
): PriceHistoryProvider {
  return {
    async readDaily(symbol, range) {
      const providerSymbol = yahooSymbol(symbol)
      let raw: ChartResultArray
      try {
        raw = await client.chart(providerSymbol, {
          interval: '1d',
          // Yahoo treats period2 as exclusive, so extend it to keep the requested end date inclusive.
          period1: range.startDate,
          period2: shiftDate(range.endDate, 1),
        })
      } catch {
        throw new ResearchProviderError('unavailable', 'yahoo')
      }
      const quotes = raw.quotes
      if (!Array.isArray(quotes) || quotes.length > MAX_RAW_HISTORY_ROWS) return invalidHistory()
      if (raw.meta?.symbol && raw.meta.symbol.toUpperCase() !== providerSymbol) return invalidHistory()

      const prices = quotes.flatMap((quote): PriceHistoryRow[] => {
        const row = normalizeChartQuote(quote)
        if (!row || row.date < range.startDate || row.date > range.endDate) return []
        return [row]
      }).sort((left, right) => left.date.localeCompare(right.date))
      if (!prices.length) return invalidHistory()
      if (new Set(prices.map((row) => row.date)).size !== prices.length) return invalidHistory()

      const source = new URL(`https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(providerSymbol)}`)
      source.searchParams.set('interval', '1d')
      source.searchParams.set('period1', range.startDate)
      source.searchParams.set('period2', range.endDate)
      return {
        adjustmentMethodology: 'OHLCV is split-adjusted; adjustedClose additionally applies dividend adjustments. Both are provider-calculated.',
        currency: raw.meta?.currency ?? 'USD',
        delay: 'end-of-day',
        exchange: raw.meta?.exchangeName ?? 'US equities EOD',
        name: raw.meta?.longName ?? raw.meta?.shortName,
        prices,
        provider: 'yahoo-finance-chart',
        skippedRowCount: quotes.length - prices.length,
        sourceUrl: source.toString(),
        symbol,
      }
    },
  }
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
  const limit = boundedInteger(input.limit, 120, 1, MAX_HISTORY_ROWS, 'Price history limit')
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

function createCompanyFundamentalsReadTool(
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

function createPriceHistoryReadTool(
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

/** One Yahoo client for both providers: yahoo-finance2 queues per instance, so a second one would double the concurrency cap. */
function createMarketResearchProviders(
  client: ResearchYahooClient = createYahooClient(),
): MarketResearchProviders {
  return {
    companyFundamentals: createYahooFundamentalsProvider(client),
    priceHistory: createYahooPriceHistoryProvider(client),
  }
}

export function createMarketResearchTools(
  providers: MarketResearchProviders = createMarketResearchProviders(),
) {
  return [
    createCompanyFundamentalsReadTool(providers.companyFundamentals),
    createPriceHistoryReadTool(providers.priceHistory),
  ]
}
