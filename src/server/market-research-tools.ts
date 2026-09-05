import { type AgentTool } from '../domain/agent-tool'
import createYahooFinance from 'yahoo-finance2/createYahooFinance'
import chart, { type ChartResultArray } from 'yahoo-finance2/modules/chart'

import { marketDate } from '../domain/catalyst'
import { EQUITY_SYMBOL_REGEX } from '../domain/instrument'
import { ISO_DATE_REGEX, isValidIsoDate } from '../domain/iso-date'
import {
  MAX_PRICE_HISTORY_PROVIDER_ROWS,
  MAX_PRICE_HISTORY_RETURNED_ROWS,
  PriceHistoryReadParameters,
  type PriceHistoryProvider,
  type PriceHistoryReadInput,
  type PriceHistoryReadResult,
  type PriceHistoryRow,
} from './market-research-contracts'
import { ResearchProviderError } from './research-provider'
import { textResult } from './agent-tool-result'
import { boundedInteger, calculateStudies, normalizeStudies } from './technical-studies'
import { boundedYahooFetch } from './yahoo-finance-transport'

export type { PriceHistoryProvider, PriceHistoryRow } from './market-research-contracts'

/**
 * Yahoo is intentionally a credential-free, delayed secondary context source.
 * It never supplies executable quotes or contracts; tastytrade remains the order
 * boundary, and every result below carries provider, delay, and adjustment labels.
 */
const ResearchYahooFinance = createYahooFinance({ modules: { chart } })

type ResearchYahooClient = {
  chart(symbol: string, options: {
    interval: '1d'
    period1: string
    period2: string
  }): Promise<ChartResultArray>
}

function dateString(value: Date | null | undefined): string | undefined {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : undefined
}

function finite(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : undefined
}

function shiftDate(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function normalizeSymbol(value: string): string {
  const symbol = value.trim().toUpperCase()
  if (!EQUITY_SYMBOL_REGEX.test(symbol)) throw new Error('Market research symbol is invalid.')
  return symbol
}

/**
 * Yahoo renders a share class with a dash (`BRK-B`) where tastytrade uses a slash
 * (`BRK/B`). The translation lives here, at the one provider boundary that needs it;
 * every symbol Spice stores or returns stays in tastytrade symbology.
 */
function yahooSymbol(symbol: string): string {
  return symbol.replaceAll('/', '-')
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

function invalidHistory(): never {
  throw new ResearchProviderError('invalid-response', 'yahoo')
}

/** `dateString` already round-trips through `toISOString`, so only the expanded-year form can slip past. */
function historyDate(value: Date): string | undefined {
  const date = dateString(value)
  return date && ISO_DATE_REGEX.test(date) ? date : undefined
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
  const adjustedClose = finite(quote.adjclose)
  const volume = finite(quote.volume)
  if (date === undefined || open === undefined || high === undefined
    || low === undefined || close === undefined || adjustedClose === undefined
    || volume === undefined) return undefined
  if (volume < 0 || low > high || open < 0 || close < 0 || adjustedClose < 0) return undefined
  return { adjustedClose, close, date, high, low, open, volume }
}

export function createYahooPriceHistoryProvider(
  client: Pick<ResearchYahooClient, 'chart'>,
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
      if (!Array.isArray(quotes) || quotes.length > MAX_PRICE_HISTORY_PROVIDER_ROWS) return invalidHistory()
      if (raw.meta?.symbol && raw.meta.symbol.toUpperCase() !== providerSymbol) return invalidHistory()
      const currency = raw.meta?.currency
      const exchange = raw.meta?.exchangeName
      if (!currency || !exchange) return invalidHistory()

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
        currency,
        delay: 'end-of-day',
        exchange,
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
  if (!isValidIsoDate(endDate)) throw new Error('Price history end date is invalid.')
  const startDate = input.startDate ?? shiftDate(endDate, -365)
  if (!isValidIsoDate(startDate)) throw new Error('Price history start date is invalid.')
  const start = Date.parse(`${startDate}T00:00:00.000Z`)
  const end = Date.parse(`${endDate}T00:00:00.000Z`)
  if (start > end) throw new Error('Price history range is invalid.')
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
  const limit = boundedInteger(input.limit, 120, 1, MAX_PRICE_HISTORY_RETURNED_ROWS, 'Price history limit')
  const requestedRange = requestedHistoryRange(input, now)
  const studyInputs = normalizeStudies(input.studies)
  const providerResult = await provider.readDaily(symbol, requestedRange)
  if (providerResult.symbol !== symbol || providerResult.prices.length > MAX_PRICE_HISTORY_PROVIDER_ROWS) {
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
    skippedRowCount: providerResult.skippedRowCount,
    sourceUrl: providerResult.sourceUrl,
    studies: calculateStudies(normalized, studyInputs, returnedStart),
    studyPriceField: 'adjustedClose',
    symbol,
    totalValidRowCount: normalized.length,
    truncated: normalized.length > prices.length,
  }
}

function createPriceHistoryReadTool(
  provider: PriceHistoryProvider,
): AgentTool<
  typeof PriceHistoryReadParameters,
  PriceHistoryReadResult
> {
  return {
    description: 'Dividend-adjusted Yahoo history with optional local SMA, EMA, RSI, MACD, or Bollinger studies; not a current quote.',
    execute: async (_toolCallId, params) => textResult(await readPriceHistory(params, provider)),
    label: 'Reading price history',
    name: 'read_price_history',
    parameters: PriceHistoryReadParameters,
  }
}

export function createMarketResearchTools(
  provider: PriceHistoryProvider = createYahooPriceHistoryProvider(createYahooClient()),
) {
  return [createPriceHistoryReadTool(provider)]
}
