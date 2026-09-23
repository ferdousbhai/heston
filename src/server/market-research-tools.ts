import { type AgentTool } from '../domain/agent-tool'
import createYahooFinance from 'yahoo-finance2/createYahooFinance'
import chart, { type ChartResultArray } from 'yahoo-finance2/modules/chart'

import { marketDate } from '../domain/catalyst'
import { EQUITY_SYMBOL_REGEX } from '../domain/instrument'
import { addDays, ISO_DATE_REGEX, isValidIsoDate } from '../domain/iso-date'
import {
  DEFAULT_PRICE_HISTORY_LOOKBACK_DAYS,
  DEFAULT_PRICE_HISTORY_ROWS,
  MAX_PRICE_HISTORY_PROVIDER_ROWS,
  MAX_PRICE_HISTORY_RETURNED_ROWS,
  PriceHistoryReadParameters,
  type PriceHistoryProvider,
  type PriceHistoryReadInput,
  type PriceHistoryReadResult,
  type PriceHistoryRow,
  roundPrice,
  PRICE_COLUMN_NOTE,
  type PriceHistoryColumns,
  STUDY_ALIGNMENT_NOTE,
} from './market-research-contracts'
import { ResearchProviderError } from './research-provider'
import { textResult } from './agent-tool-result'
import { boundedInteger, calculateStudies, normalizeStudies } from './technical-studies'
import { boundedYahooFetch } from './yahoo-finance-transport'
import { CallerVisibleError } from './caller-visible-error'

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

function normalizeSymbol(value: string): string {
  const symbol = value.trim().toUpperCase()
  if (!EQUITY_SYMBOL_REGEX.test(symbol)) throw new CallerVisibleError('Market research symbol is invalid.')
  return symbol
}

/**
 * Yahoo renders a share class with a dash (`BRK-B`) where tastytrade uses a slash
 * (`BRK/B`). The translation lives here, at the one provider boundary that needs it;
 * every symbol Heston stores or returns stays in tastytrade symbology.
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
          period2: addDays(range.endDate, 1),
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

/** One array per field, in the order a reader of the note above expects to find them. */
function priceColumns(rows: readonly PriceHistoryRow[]): PriceHistoryColumns {
  return {
    adjustedClose: rows.map((row) => row.adjustedClose),
    close: rows.map((row) => row.close),
    date: rows.map((row) => row.date),
    high: rows.map((row) => row.high),
    low: rows.map((row) => row.low),
    open: rows.map((row) => row.open),
    volume: rows.map((row) => row.volume),
  }
}

/** `PRICE_DECIMAL_PLACES` carries why; volume is a count and keeps every digit it arrived with. */
function roundedRow(row: PriceHistoryRow): PriceHistoryRow {
  return {
    adjustedClose: roundPrice(row.adjustedClose),
    close: roundPrice(row.close),
    date: row.date,
    high: roundPrice(row.high),
    low: roundPrice(row.low),
    open: roundPrice(row.open),
    volume: row.volume,
  }
}

function requestedHistoryRange(input: PriceHistoryReadInput, now: Date) {
  const endDate = input.endDate ?? marketDate(now)
  if (!isValidIsoDate(endDate)) throw new CallerVisibleError('Price history end date is invalid.')
  const startDate = input.startDate ?? addDays(endDate, -DEFAULT_PRICE_HISTORY_LOOKBACK_DAYS)
  if (!isValidIsoDate(startDate)) throw new CallerVisibleError('Price history start date is invalid.')
  const start = Date.parse(`${startDate}T00:00:00.000Z`)
  const end = Date.parse(`${endDate}T00:00:00.000Z`)
  if (start > end) throw new CallerVisibleError('Price history range is invalid.')
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
  if (interval !== '1d' && interval !== '1wk' && interval !== '1mo') throw new CallerVisibleError('Price history interval is invalid.')
  const limit = boundedInteger(input.limit, DEFAULT_PRICE_HISTORY_ROWS, 1, MAX_PRICE_HISTORY_RETURNED_ROWS, 'Price history limit')
  const requestedRange = requestedHistoryRange(input, now)
  const studyInputs = normalizeStudies(input.studies)
  const providerResult = await provider.readDaily(symbol, requestedRange)
  if (providerResult.symbol !== symbol || providerResult.prices.length > MAX_PRICE_HISTORY_PROVIDER_ROWS) {
    throw new CallerVisibleError('Price history provider returned a mismatched or oversized response.')
  }
  const daily = [...providerResult.prices].sort((left, right) => left.date.localeCompare(right.date))
  if (!daily.length || new Set(daily.map((row) => row.date)).size !== daily.length) {
    throw new CallerVisibleError('Price history provider returned no usable unique rows.')
  }
  const normalized = aggregateHistory(daily, interval)
  const returnedStart = Math.max(0, normalized.length - limit)
  // Rounded here and nowhere earlier: the studies below read the full-precision rows, and only
  // what leaves the Worker sheds the provider's float32-rendering digits.
  const returnedRows = normalized.slice(returnedStart).map(roundedRow)
  const prices = priceColumns(returnedRows)
  const studies = calculateStudies(normalized, studyInputs, returnedStart)
  const result: PriceHistoryReadResult = {
    adjustment: 'adjusted-close',
    adjustmentMethodology: providerResult.adjustmentMethodology,
    currency: providerResult.currency,
    dataAsOf: returnedRows.at(-1)!.date,
    delay: providerResult.delay,
    exchange: providerResult.exchange,
    fetchedAt: now.toISOString(),
    interval,
    name: providerResult.name,
    priceColumns: PRICE_COLUMN_NOTE,
    prices,
    provider: providerResult.provider,
    requestedRange,
    skippedRowCount: providerResult.skippedRowCount,
    sourceUrl: providerResult.sourceUrl,
    studies,
    studyPriceField: 'adjustedClose',
    symbol,
    totalValidRowCount: normalized.length,
    truncated: normalized.length > returnedRows.length,
  }
  // A history with no studies has nothing to align, and the note is not free: it rides along in
  // every result that carries it.
  if (studies.length) result.studyAlignment = STUDY_ALIGNMENT_NOTE
  return result
}

function createPriceHistoryReadTool(
  provider: PriceHistoryProvider,
): AgentTool<typeof PriceHistoryReadParameters> {
  return {
    // The alignment sentence is the one thing a model cannot infer from the payload and must not
    // guess at: a study read one row out is worse than no study at all.
    description: 'Dividend-adjusted Yahoo history with optional local SMA, EMA, RSI, MACD, or Bollinger studies; not a current quote. A study series carries only the values it has: values[i] is for prices[firstPriceIndex + i].',
    execute: async (params) => textResult(await readPriceHistory(params, provider)),
    name: 'read_price_history',
    parameters: PriceHistoryReadParameters,
  }
}

export function createMarketResearchTools(
  provider: PriceHistoryProvider = createYahooPriceHistoryProvider(createYahooClient()),
) {
  return [createPriceHistoryReadTool(provider)]
}
