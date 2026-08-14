import { type Ticker } from '../domain/market'
import { newYorkClock } from '../domain/market-clock'
import { type AppEnv } from './env'
import { resolveAccountNumber, tastyRequest } from './tastytrade'
import {
  accountBalancesFromPayload,
  type AccountBalances,
  type RecentTrade,
  tradeTransactionRecord,
  type WorkingOrder,
  workingOrderRecords,
} from './tastytrade-payload'

type JsonRecord = Record<string, unknown>

type BrokerageBalances = Partial<AccountBalances>

export interface BrokerageContext {
  accountNumber: string
  asOf: string
  balances: BrokerageBalances
  availability: { balances: boolean; orders: boolean; positions: boolean; trades: boolean }
  orders: WorkingOrder[]
  positions: Array<{
    averageOpenPrice?: number
    direction: 'Long' | 'Short'
    expiresAt?: string
    instrumentType: string
    quantity: number
    symbol: string
    underlying: string
  }>
  recentTrades: RecentTrade[]
  source: 'tastytrade'
  completeness: {
    ordersTruncated: boolean
    positionsTruncated: boolean
    tradesTruncated: boolean
  }
}

type BrokeragePosition = BrokerageContext['positions'][number]

function optionExpiry(position: BrokeragePosition): string | undefined {
  if (position.expiresAt) return position.expiresAt
  if (!position.instrumentType.toLowerCase().includes('option')) return undefined
  const compact = position.symbol.replaceAll(' ', '')
  const match = compact.match(/(\d{6})[CP]\d{8}$/)
  if (!match) return undefined
  const year = 2000 + Number(match[1]!.slice(0, 2))
  const month = Number(match[1]!.slice(2, 4))
  const day = Number(match[1]!.slice(4, 6))
  const expiry = new Date(Date.UTC(year, month - 1, day, 20))
  return expiry.getUTCFullYear() === year && expiry.getUTCMonth() === month - 1 && expiry.getUTCDate() === day
    ? expiry.toISOString()
    : undefined
}

/** Keep near-expiry exercise and assignment risk visible without turning advice into a hard veto. */
export function buildExpiryAwareness(positions: readonly BrokeragePosition[], now = new Date()) {
  const nowMs = now.getTime()
  if (!Number.isFinite(nowMs)) throw new Error('Expiry awareness requires a valid date.')
  const currentMarketDate = Date.parse(`${newYorkClock(now).localDate}T00:00:00.000Z`)
  const risks = positions.flatMap((position) => {
    const expiresAt = optionExpiry(position)
    if (!expiresAt) return []
    const expiryMarketDate = Date.parse(`${expiresAt.slice(0, 10)}T00:00:00.000Z`)
    const daysUntilExpiry = Math.round((expiryMarketDate - currentMarketDate) / 86_400_000)
    if (daysUntilExpiry > 30) return []
    const urgency = daysUntilExpiry < 0 ? 'expired'
      : daysUntilExpiry === 0 ? 'expiry-day'
        : daysUntilExpiry <= 3 ? 'within-3-days'
          : daysUntilExpiry <= 7 ? 'within-7-days'
            : 'within-30-days'
    return [{
      daysUntilExpiry,
      direction: position.direction,
      expiresAt,
      quantity: position.quantity,
      symbol: position.symbol,
      underlying: position.underlying,
      urgency,
    }]
  })
  return risks.sort((left, right) => left.daysUntilExpiry - right.daysUntilExpiry).slice(0, 20)
}

type AgentMarketTicker = Pick<Ticker,
  'changePercent' | 'earningsDate' | 'ivIndex' | 'ivPercentile' | 'ivRank' | 'liquidity' | 'price' | 'symbol'>

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function strictItems(value: unknown): JsonRecord[] {
  const body = record(value)
  const rawData = body?.data ?? value
  const data = record(rawData)
  const candidate = Array.isArray(rawData) ? rawData : data?.items ?? body?.items
  if (!Array.isArray(candidate)) throw new Error('TastytradeAccount:invalid-collection')
  return candidate.map((item) => {
    const row = record(item)
    if (!row) throw new Error('TastytradeAccount:invalid-collection')
    return row
  })
}

function paginationTotal(value: unknown): number | undefined {
  const body = record(value)
  const data = record(body?.data)
  const pagination = record(body?.pagination) ?? record(data?.pagination)
  const raw = pagination?.['total-items']
  if (raw === undefined || raw === null) return undefined
  const parsed = number(raw)
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function positionFromRecord(row: JsonRecord): BrokerageContext['positions'][number] | undefined {
  const symbol = text(row.symbol)
  const underlying = text(row['underlying-symbol'])?.toUpperCase()
  const quantity = number(row.quantity)
  const direction = text(row['quantity-direction'])
  const instrumentType = text(row['instrument-type'])
  if (!symbol
    || !underlying
    || quantity === undefined
    || (direction !== 'Long' && direction !== 'Short')
    || !instrumentType) {
    throw new Error('TastytradeAccount:invalid-position')
  }
  if (quantity === 0) return undefined
  const averageOpenPrice = number(row['average-open-price'])
  const rawExpiry = text(row['expires-at'])
  const expiresAt = rawExpiry && Number.isFinite(Date.parse(rawExpiry)) ? rawExpiry : undefined
  return {
    direction,
    instrumentType,
    quantity,
    symbol,
    underlying,
    ...(averageOpenPrice !== undefined ? { averageOpenPrice } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  }
}

function parsedPositions(result: PromiseSettledResult<unknown>) {
  if (result.status !== 'fulfilled') return { available: false, positions: [] }
  try {
    const rows = strictItems(result.value)
    const total = paginationTotal(result.value)
    if ((total !== undefined && total > rows.length) || (total === undefined && rows.length >= 200)) {
      return { available: false, positions: [], truncated: true }
    }
    const positions = rows.flatMap((row) => {
      const position = positionFromRecord(row)
      return position ? [position] : []
    })
    if (rows.length > 100) return { available: false, positions: [], truncated: true }
    return { available: true, positions, truncated: false }
  } catch {
    return { available: false, positions: [] }
  }
}

function parsedOrders(
  orderResult: PromiseSettledResult<unknown>,
  complexOrderResult: PromiseSettledResult<unknown>,
) {
  if (orderResult.status !== 'fulfilled' || complexOrderResult.status !== 'fulfilled') {
    return { available: false, orders: [] }
  }
  try {
    const ordinary = strictItems(orderResult.value)
    const complex = strictItems(complexOrderResult.value)
    const ordinaryTotal = paginationTotal(orderResult.value)
    const complexTotal = paginationTotal(complexOrderResult.value)
    if ((ordinaryTotal !== undefined && ordinaryTotal > ordinary.length)
      || (complexTotal !== undefined && complexTotal > complex.length)
      || (ordinaryTotal === undefined && ordinary.length >= 200)
      || (complexTotal === undefined && complex.length >= 200)) {
      return { available: false, orders: [], truncated: true }
    }
    const normalized = [
      ...ordinary,
      ...complex,
    ].flatMap(workingOrderRecords)
    const byId = new Map(normalized.map((order) => [order.id, order]))
    const orders = [...byId.values()]
    if (orders.length > 100) return { available: false, orders: [], truncated: true }
    return { available: true, orders, truncated: false }
  } catch {
    return { available: false, orders: [] }
  }
}

function parsedTrades(result: PromiseSettledResult<unknown>) {
  if (result.status !== 'fulfilled') return { available: false, trades: [] }
  try {
    const rows = strictItems(result.value)
    const total = paginationTotal(result.value)
    const truncated = rows.length >= 25 || (total !== undefined && total > rows.length)
    return { available: true, trades: rows.map(tradeTransactionRecord).slice(0, 25), truncated }
  } catch {
    return { available: false, trades: [] }
  }
}

export async function loadBrokerageContext(env: AppEnv): Promise<BrokerageContext> {
  const account = await resolveAccountNumber(env)
  const recentStartDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10)
  const [positionResult, balanceResult, orderResult, complexOrderResult, tradeResult] = await Promise.allSettled([
    tastyRequest(env, `/accounts/${encodeURIComponent(account)}/positions?per-page=200`),
    tastyRequest(env, `/accounts/${encodeURIComponent(account)}/balances`),
    tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders/live?per-page=200`),
    tastyRequest(env, `/accounts/${encodeURIComponent(account)}/complex-orders/live?per-page=200`),
    tastyRequest(env, `/accounts/${encodeURIComponent(account)}/transactions?type=Trade&sort=Desc&per-page=25&start-date=${recentStartDate}`),
  ])
  const positionSection = parsedPositions(positionResult)
  const orderSection = parsedOrders(orderResult, complexOrderResult)
  const tradeSection = parsedTrades(tradeResult)
  const exactBalances = balanceResult.status === 'fulfilled'
    ? accountBalancesFromPayload(balanceResult.value, account)
    : undefined
  const balances: BrokerageBalances = exactBalances ?? {}
  return {
    accountNumber: account,
    asOf: new Date().toISOString(),
    source: 'tastytrade',
    completeness: {
      ordersTruncated: Boolean(orderSection.truncated),
      positionsTruncated: Boolean(positionSection.truncated),
      tradesTruncated: Boolean(tradeSection.truncated),
    },
    availability: {
      balances: exactBalances !== undefined,
      orders: orderSection.available,
      positions: positionSection.available,
      trades: tradeSection.available,
    },
    balances,
    positions: positionSection.positions,
    orders: orderSection.orders,
    recentTrades: tradeSection.trades,
  }
}

/** Keep model context factual and compact while retaining the account data needed for brokerage actions. */
export function buildAgentRuntimeContext(
  context: BrokerageContext | undefined,
  tickers: readonly AgentMarketTicker[] = [],
  selectedTicker?: AgentMarketTicker,
) {
  const relevantSymbols = new Set(context?.positions.map((position) => position.underlying))
  if (selectedTicker) relevantSymbols.add(selectedTicker.symbol.toUpperCase())
  const tickerBySymbol = new Map([...tickers, ...(selectedTicker ? [selectedTicker] : [])]
    .map((ticker) => [ticker.symbol.toUpperCase(), ticker]))
  const marketMetrics = Object.fromEntries([...relevantSymbols].flatMap((symbol) => {
    const ticker = tickerBySymbol.get(symbol)
    return ticker ? [[symbol, {
      price: ticker.price,
      changePercent: ticker.changePercent,
      ivIndex: ticker.ivIndex,
      ivRank: ticker.ivRank,
      ivPercentile: ticker.ivPercentile,
      liquidity: ticker.liquidity,
      earningsDate: ticker.earningsDate,
    }]] : []
  }))
  const marketContext = {
    ...(selectedTicker ? { selectedSymbol: selectedTicker.symbol } : {}),
    ...(Object.keys(marketMetrics).length ? { marketMetrics } : {}),
  }
  if (!context) return marketContext

  const unavailable = (Object.entries(context.availability) as Array<[keyof BrokerageContext['availability'], boolean]>)
    .filter(([, available]) => !available)
    .map(([section]) => section)

  return {
    ...marketContext,
    asOf: context.asOf,
    source: context.source,
    completeness: context.completeness,
    balances: {
      availableTradingFunds: context.balances.availableTradingFunds,
      cashAvailableToWithdraw: context.balances.cashAvailableToWithdraw,
      cashBalance: context.balances.cashBalance,
      dayTradingBuyingPower: context.balances.dayTradingBuyingPower,
      derivativeBuyingPower: context.balances.derivativeBuyingPower,
      equityBuyingPower: context.balances.equityBuyingPower,
      netLiquidatingValue: context.balances.netLiquidatingValue,
    },
    // tastytrade deprecates REST position marks for P/L; exact live quotes belong in a market-data tool.
    positions: context.positions.map((position) => ({
      ...(position.averageOpenPrice === undefined ? {} : { averageOpenPrice: position.averageOpenPrice }),
      direction: position.direction,
      ...(position.expiresAt === undefined ? {} : { expiresAt: position.expiresAt }),
      instrumentType: position.instrumentType,
      quantity: position.quantity,
      symbol: position.symbol,
      underlying: position.underlying,
    })),
    orders: context.orders,
    recentTrades: context.recentTrades,
    expiryAwareness: buildExpiryAwareness(context.positions),
    ...(unavailable.length ? { unavailable } : {}),
  }
}
