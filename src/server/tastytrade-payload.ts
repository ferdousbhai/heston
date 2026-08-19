import {
  JsonArraySchema,
  JsonObjectSchema,
  LooseTextSchema,
  NumericSchema,
  TextSchema,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'

export interface AccountBalances {
  availableTradingFunds: number
  cashAvailableToWithdraw: number
  cashBalance: number
  dayTradingBuyingPower: number
  derivativeBuyingPower: number
  equityBuyingPower: number
  netLiquidatingValue: number
}

export interface RecentTrade {
  action: string
  executedAt: string
  instrumentType: string
  orderId: string
  price: number
  quantity: number
  symbol: string
  underlying: string
}

export interface WorkingOrder {
  complexOrderId?: string
  id: string
  legs: Array<{ action: string; instrumentType: string; quantity: number; symbol: string }>
  price?: number
  priceEffect?: string
  status: string
  symbol: string
  timeInForce?: string
  type: string
}

function matchesAccount(row: JsonObject, accountNumber: string): boolean {
  if (!Object.hasOwn(row, 'account-number')) return true
  return TextSchema.safeParse(row['account-number']).data === accountNumber
}

/** Normalize both tastytrade balance envelopes without guessing among multiple accounts. */
export function accountBalanceRecord(payload: JsonValue, accountNumber: string): JsonObject | undefined {
  const body = JsonObjectSchema.safeParse(payload).data
  const rawData = body?.data ?? payload
  const data = JsonObjectSchema.safeParse(rawData).data
  const items = JsonArraySchema.safeParse(rawData).data ?? JsonArraySchema.safeParse(data?.items).data
  if (items) {
    if (items.length !== 1) return undefined
    const row = JsonObjectSchema.safeParse(items[0]).data
    return row && matchesAccount(row, accountNumber) ? row : undefined
  }
  return data && matchesAccount(data, accountNumber) ? data : undefined
}

const TERMINAL_ORDER_STATUSES = new Set(['cancelled', 'expired', 'filled', 'rejected', 'removed'])

/** Treat incomplete or unfamiliar order states as working; exclude only verified terminal rows. */
export function isWorkingOrderRecord(row: JsonObject): boolean {
  if (TextSchema.safeParse(row['terminal-at']).data) return false
  const status = TextSchema.safeParse(row.status).data?.toLowerCase() ?? ''
  return !TERMINAL_ORDER_STATUSES.has(status)
}

function text(value: JsonValue): string | undefined {
  return TextSchema.safeParse(value).data
}

function number(value: JsonValue): number | undefined {
  return NumericSchema.safeParse(value).data
}

/** Broker identifiers arrive as strings or numbers and must stay short enough to log and index. */
function id(value: JsonValue): string | undefined {
  const parsed = LooseTextSchema.safeParse(value).data
  return parsed !== undefined && parsed.length <= 80 ? parsed : undefined
}

function requiredNumber(row: JsonObject, field: string): number {
  const parsed = number(row[field])
  if (parsed === undefined) throw new Error(`TastytradePayload:invalid-${field}`)
  return parsed
}

/** Extract the complete compact balance set needed by Dan; partial records are unavailable. */
export function accountBalancesFromPayload(payload: JsonValue, accountNumber: string): AccountBalances | undefined {
  const row = accountBalanceRecord(payload, accountNumber)
  if (!row) return undefined
  try {
    return {
      availableTradingFunds: requiredNumber(row, 'available-trading-funds'),
      cashAvailableToWithdraw: requiredNumber(row, 'cash-available-to-withdraw'),
      cashBalance: requiredNumber(row, 'cash-balance'),
      dayTradingBuyingPower: requiredNumber(row, 'day-trading-buying-power'),
      derivativeBuyingPower: requiredNumber(row, 'derivative-buying-power'),
      equityBuyingPower: requiredNumber(row, 'equity-buying-power'),
      netLiquidatingValue: number(row['net-liquidating-value'])
        ?? requiredNumber(row, 'net-liquidating-value-snapshot'),
    }
  } catch {
    return undefined
  }
}

function workingOrderLeg(value: JsonValue) {
  const row = JsonObjectSchema.safeParse(value).data
  const action = text(row?.action)
  const instrumentType = text(row?.['instrument-type'])
  const quantity = number(row?.quantity)
  const symbol = text(row?.symbol)
  if (!row || !action || !instrumentType || quantity === undefined || quantity <= 0 || !symbol) {
    throw new Error('TastytradePayload:invalid-order-leg')
  }
  return { action, instrumentType, quantity, symbol }
}

function workingOrder(row: JsonObject, complexOrderId?: string): WorkingOrder {
  const orderId = id(row.id)
  const status = text(row.status)
  const type = text(row['order-type'])
  const rawLegs = JsonArraySchema.safeParse(row.legs).data
  if (!orderId || !status || !type || !rawLegs?.length) {
    throw new Error('TastytradePayload:invalid-working-order')
  }
  const legs = rawLegs.map(workingOrderLeg)
  const price = number(row.price)
  const priceEffect = text(row['price-effect'])
  const timeInForce = text(row['time-in-force'])
  const order: WorkingOrder = { id: orderId, legs, status, symbol: legs[0]!.symbol, type }
  if (complexOrderId) order.complexOrderId = complexOrderId
  if (price !== undefined) order.price = price
  if (priceEffect) order.priceEffect = priceEffect
  if (timeInForce) order.timeInForce = timeInForce
  return order
}

/** Normalize either an ordinary order or the active children of a complex order. */
export function workingOrderRecords(row: JsonObject): WorkingOrder[] {
  if (!isWorkingOrderRecord(row)) return []
  if (JsonArraySchema.safeParse(row.legs).success) return [workingOrder(row)]

  const complexOrderId = id(row.id)
  if (!complexOrderId) throw new Error('TastytradePayload:invalid-complex-order')
  const childOrders = JsonArraySchema.safeParse(row.orders).data
  if (Object.hasOwn(row, 'orders') && !childOrders) {
    throw new Error('TastytradePayload:invalid-complex-order')
  }
  const nested = (childOrders ?? []).map((value) => {
    const order = JsonObjectSchema.safeParse(value).data
    if (!order) throw new Error('TastytradePayload:invalid-complex-order')
    return order
  })
  if (Object.hasOwn(row, 'trigger-order')) {
    const trigger = JsonObjectSchema.safeParse(row['trigger-order']).data
    if (!trigger) throw new Error('TastytradePayload:invalid-complex-order')
    nested.push(trigger)
  }
  if (!nested.length) throw new Error('TastytradePayload:invalid-complex-order')
  return nested.filter(isWorkingOrderRecord).map((order) => workingOrder(order, complexOrderId))
}

/** Normalize one canonical Trade transaction without fees or descriptive broker text. */
export function tradeTransactionRecord(row: JsonObject): RecentTrade {
  const action = text(row.action)
  const executedAt = text(row['executed-at']) ?? text(row['transaction-date'])
  const instrumentType = text(row['instrument-type'])
  const orderId = id(row['order-id'])
  const price = number(row.price)
  const quantity = number(row.quantity)
  const symbol = text(row.symbol)
  const underlying = text(row['underlying-symbol'])
  if (text(row['transaction-type']) !== 'Trade'
    || !action
    || !executedAt
    || !instrumentType
    || !orderId
    || price === undefined
    || quantity === undefined
    || quantity <= 0
    || !symbol
    || !underlying) {
    throw new Error('TastytradePayload:invalid-trade-transaction')
  }
  return { action, executedAt, instrumentType, orderId, price, quantity, symbol, underlying }
}
