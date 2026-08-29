import { type Ticker } from '../domain/market'
import { type AppEnv } from './env'
import { brokerApi } from './tastytrade'
import {
  accountBalancesFromPayload,
  type AccountBalances,
  type WorkingOrder,
  workingOrderRecords,
} from './tastytrade-payload'

import {
  envelopeRows,
  envelopeTotalItems,
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
  availability: { balances: boolean; orders: boolean; positions: boolean }
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
  source: 'tastytrade'
  completeness: {
    ordersTruncated: boolean
    positionsTruncated: boolean
  }
}

type BrokeragePosition = BrokerageContext['positions'][number]

type AgentMarketTicker = Pick<Ticker,
  'changePercent' | 'earningsDate' | 'ivIndex' | 'ivPercentile' | 'ivRank' | 'liquidity' | 'marketCap' | 'price' | 'symbol' | 'volume'>

type AgentMarketContext = {
  marketMetrics?: Record<string, Omit<AgentMarketTicker, 'symbol'>>
  selectedSymbol?: string
}

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
  const candidate = envelopeRows(value)
  if (!candidate) throw new Error('TastytradeAccount:invalid-collection')
  return candidate.map((item) => {
    const row = jsonObject(item)
    if (!row) throw new Error('TastytradeAccount:invalid-collection')
    return row
  })
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

type BrokerageSection<Row> = { available: boolean; rows: Row[]; truncated?: boolean }

/**
 * Every account section degrades the same way: a request that did not settle, or a page Spice
 * could not fully decode, reports itself unavailable with no rows and no truncation claim,
 * never a partial view the model could mistake for the whole account. Each caller keeps its
 * own completeness rule, because per-page limits and truncation meaning differ by endpoint.
 */
function section<Row>(
  results: readonly PromiseSettledResult<JsonValue>[],
  parse: (...payloads: JsonValue[]) => BrokerageSection<Row>,
): BrokerageSection<Row> {
  const payloads: JsonValue[] = []
  for (const result of results) {
    if (result.status !== 'fulfilled') return { available: false, rows: [] }
    payloads.push(result.value)
  }
  try {
    return parse(...payloads)
  } catch {
    return { available: false, rows: [] }
  }
}

function parsedPositions(result: PromiseSettledResult<JsonValue>) {
  return section<BrokeragePosition>([result], (payload) => {
    const rows = strictItems(payload)
    const total = envelopeTotalItems(payload)
    if ((total !== undefined && total > rows.length) || (total === undefined && rows.length >= 200)) {
      return { available: false, rows: [], truncated: true }
    }
    const positions = rows.flatMap((row) => {
      const position = positionFromRecord(row)
      return position ? [position] : []
    })
    if (rows.length > 100) return { available: false, rows: [], truncated: true }
    return { available: true, rows: positions, truncated: false }
  })
}

function parsedOrders(
  orderResult: PromiseSettledResult<JsonValue>,
  complexOrderResult: PromiseSettledResult<JsonValue>,
) {
  return section<WorkingOrder>([orderResult, complexOrderResult], (ordinaryPayload, complexPayload) => {
    const ordinary = strictItems(ordinaryPayload)
    const complex = strictItems(complexPayload)
    const ordinaryTotal = envelopeTotalItems(ordinaryPayload)
    const complexTotal = envelopeTotalItems(complexPayload)
    if ((ordinaryTotal !== undefined && ordinaryTotal > ordinary.length)
      || (complexTotal !== undefined && complexTotal > complex.length)
      || (ordinaryTotal === undefined && ordinary.length >= 200)
      || (complexTotal === undefined && complex.length >= 200)) {
      return { available: false, rows: [], truncated: true }
    }
    const normalized = [
      ...ordinary,
      ...complex,
    ].flatMap(workingOrderRecords)
    const byId = new Map(normalized.map((order) => [order.id, order]))
    const orders = [...byId.values()]
    if (orders.length > 100) return { available: false, rows: [], truncated: true }
    return { available: true, rows: orders, truncated: false }
  })
}

export async function loadBrokerageContext(env: AppEnv): Promise<BrokerageContext> {
  const account = await brokerApi().resolveAccountNumber(env)
  const [positionResult, balanceResult, orderResult, complexOrderResult] = await Promise.allSettled([
    brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/positions?per-page=200`),
    brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/balances`),
    brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders/live?per-page=200`),
    brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/complex-orders/live?per-page=200`),
  ])
  const positionSection = parsedPositions(positionResult)
  const orderSection = parsedOrders(orderResult, complexOrderResult)
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
    },
    availability: {
      balances: exactBalances !== undefined,
      orders: orderSection.available,
      positions: positionSection.available,
    },
    balances,
    positions: positionSection.rows,
    orders: orderSection.rows,
  }
}

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
  }
  return unavailable.length ? { ...runtimeContext, unavailable } : runtimeContext
}
