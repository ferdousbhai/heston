import { type Ticker } from '../domain/market'
import { newYorkClock } from '../domain/market-clock'
import { type AppEnv } from './env'
import { brokerApi } from './tastytrade'
import {
  accountBalancesFromPayload,
  type AccountBalances,
  type RecentTrade,
  tradeTransactionRecord,
  type WorkingOrder,
  workingOrderRecords,
} from './tastytrade-payload'

import {
  JsonArraySchema,
  jsonNumber,
  jsonObject,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'

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
  'changePercent' | 'earningsDate' | 'ivIndex' | 'ivPercentile' | 'ivRank' | 'liquidity' | 'marketCap' | 'price' | 'symbol' | 'volume'>

/** The market slice of Dan's runtime context, keyed by the symbols his positions actually touch. */
type AgentMarketContext = {
  marketMetrics?: Record<string, Omit<AgentMarketTicker, 'symbol'>>
  selectedSymbol?: string
}

/** Positions as Dan sees them: the stored position with absent optional fields left out. */
function agentPosition(position: BrokeragePosition): BrokeragePosition {
  const projected: BrokeragePosition = {
    direction: position.direction,
    instrumentType: position.instrumentType,
    quantity: position.quantity,
    symbol: position.symbol,
    underlying: position.underlying,
  }
  if (position.averageOpenPrice !== undefined) projected.averageOpenPrice = position.averageOpenPrice
  if (position.expiresAt !== undefined) projected.expiresAt = position.expiresAt
  return projected
}

function strictItems(value: JsonValue): JsonObject[] {
  const body = jsonObject(value)
  const rawData = body?.data ?? value
  const data = jsonObject(rawData)
  const candidate = JsonArraySchema.safeParse(rawData).data
    ?? JsonArraySchema.safeParse(data?.items ?? body?.items).data
  if (!candidate) throw new Error('TastytradeAccount:invalid-collection')
  return candidate.map((item) => {
    const row = jsonObject(item)
    if (!row) throw new Error('TastytradeAccount:invalid-collection')
    return row
  })
}

function paginationTotal(value: JsonValue): number | undefined {
  const body = jsonObject(value)
  const data = jsonObject(body?.data)
  const pagination = jsonObject(body?.pagination) ?? jsonObject(data?.pagination)
  const raw = pagination?.['total-items']
  if (raw === undefined || raw === null) return undefined
  const parsed = jsonNumber(raw)
  return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function positionFromRecord(row: JsonObject): BrokerageContext['positions'][number] | undefined {
  const symbol = jsonText(row.symbol)
  const underlying = jsonText(row['underlying-symbol'])?.toUpperCase()
  const quantity = jsonNumber(row.quantity)
  const direction = jsonText(row['quantity-direction'])
  const instrumentType = jsonText(row['instrument-type'])
  if (!symbol
    || !underlying
    || quantity === undefined
    || (direction !== 'Long' && direction !== 'Short')
    || !instrumentType) {
    throw new Error('TastytradeAccount:invalid-position')
  }
  if (quantity === 0) return undefined
  const averageOpenPrice = jsonNumber(row['average-open-price'])
  const rawExpiry = jsonText(row['expires-at'])
  const expiresAt = rawExpiry && Number.isFinite(Date.parse(rawExpiry)) ? rawExpiry : undefined
  const position: BrokeragePosition = { direction, instrumentType, quantity, symbol, underlying }
  if (averageOpenPrice !== undefined) position.averageOpenPrice = averageOpenPrice
  if (expiresAt) position.expiresAt = expiresAt
  return position
}

function parsedPositions(result: PromiseSettledResult<JsonValue>) {
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
  orderResult: PromiseSettledResult<JsonValue>,
  complexOrderResult: PromiseSettledResult<JsonValue>,
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

function parsedTrades(result: PromiseSettledResult<JsonValue>) {
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
  const account = await brokerApi().resolveAccountNumber(env)
  const recentStartDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString().slice(0, 10)
  const [positionResult, balanceResult, orderResult, complexOrderResult, tradeResult] = await Promise.allSettled([
    brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/positions?per-page=200`),
    brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/balances`),
    brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders/live?per-page=200`),
    brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/complex-orders/live?per-page=200`),
    brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/transactions?type=Trade&sort=Desc&per-page=25&start-date=${recentStartDate}`),
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
    if (!ticker) return []
    const metrics: Omit<AgentMarketTicker, 'symbol'> = {
      price: ticker.price,
      changePercent: ticker.changePercent,
      ivIndex: ticker.ivIndex,
      ivRank: ticker.ivRank,
      ivPercentile: ticker.ivPercentile,
      liquidity: ticker.liquidity,
      earningsDate: ticker.earningsDate,
    }
    if (ticker.marketCap !== undefined) metrics.marketCap = ticker.marketCap
    if (ticker.volume !== undefined) metrics.volume = ticker.volume
    return [[symbol, metrics]]
  }))
  const marketContext: AgentMarketContext = {}
  if (selectedTicker) marketContext.selectedSymbol = selectedTicker.symbol
  if (Object.keys(marketMetrics).length) marketContext.marketMetrics = marketMetrics
  if (!context) return marketContext

  const unavailable = Object.entries(context.availability)
    .filter(([, available]) => !available)
    .map(([section]) => section)

  const runtimeContext = {
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
    positions: context.positions.map(agentPosition),
    orders: context.orders,
    recentTrades: context.recentTrades,
    expiryAwareness: buildExpiryAwareness(context.positions),
  }
  return unavailable.length ? { ...runtimeContext, unavailable } : runtimeContext
}
