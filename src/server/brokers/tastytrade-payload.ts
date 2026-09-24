import {
  envelopeRows,
  envelopeTotalItems,
  JsonArraySchema,
  jsonLooseText,
  jsonNumber,
  jsonObject,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../../domain/json-payload'
import { BROKER_ORDER_ID_MAX_LENGTH, type BrokerBalances, type BrokerWorkingOrder } from '../../domain/broker'

// Account reads request one large broker page. completeAccountRows rejects a reported
// larger total or a full page without a total, so this is a completeness boundary.
export const BROKER_ACCOUNT_PAGE_SIZE = 200

/** Parse one complete account page; malformed or ambiguous pagination fails closed. */
export function completeAccountRows(payload: JsonValue, label: string): JsonObject[] {
  const candidate = envelopeRows(payload)
  if (!candidate) throw new Error(`TastytradeAccount:invalid-${label}-collection`)
  const rows = candidate.map((item) => {
    const row = jsonObject(item)
    if (!row) throw new Error(`TastytradeAccount:invalid-${label}-collection`)
    return row
  })
  const total = envelopeTotalItems(payload)
  const body = jsonObject(payload)
  const data = jsonObject(body?.data)
  const rawPagination = body?.pagination ?? data?.pagination
  if (rawPagination !== undefined && rawPagination !== null) {
    const pagination = jsonObject(rawPagination)
    if (!pagination || (Object.hasOwn(pagination, 'total-items') && total === undefined)) {
      throw new Error(`TastytradeAccount:invalid-${label}-pagination`)
    }
  }
  if ((total !== undefined && total !== rows.length)
    || (total === undefined && rows.length >= BROKER_ACCOUNT_PAGE_SIZE)) {
    throw new Error(`TastytradeAccount:incomplete-${label}`)
  }
  return rows
}

function matchesAccount(row: JsonObject, accountNumber: string): boolean {
  if (!Object.hasOwn(row, 'account-number')) return true
  return jsonText(row['account-number']) === accountNumber
}

/** Normalize both tastytrade balance envelopes without guessing among multiple accounts. */
export function accountBalanceRecord(payload: JsonValue, accountNumber: string): JsonObject | undefined {
  const body = jsonObject(payload)
  const rawData = body?.data ?? payload
  const data = jsonObject(rawData)
  const items = JsonArraySchema.safeParse(rawData).data ?? JsonArraySchema.safeParse(data?.items).data
  if (items) {
    if (items.length !== 1) return undefined
    const row = jsonObject(items[0])
    return row && matchesAccount(row, accountNumber) ? row : undefined
  }
  return data && matchesAccount(data, accountNumber) ? data : undefined
}

const TERMINAL_ORDER_STATUSES = new Set(['cancelled', 'expired', 'filled', 'rejected', 'removed'])

/** Treat incomplete or unfamiliar order states as working; exclude only verified terminal rows. */
export function isWorkingOrderRecord(row: JsonObject): boolean {
  if (jsonText(row['terminal-at'])) return false
  const status = jsonText(row.status)?.toLowerCase() ?? ''
  return !TERMINAL_ORDER_STATUSES.has(status)
}

function id(value: JsonValue): string | undefined {
  const parsed = jsonLooseText(value)
  return parsed !== undefined && parsed.length <= BROKER_ORDER_ID_MAX_LENGTH ? parsed : undefined
}

function requiredNumber(row: JsonObject, field: string): number {
  const parsed = jsonNumber(row[field])
  if (parsed === undefined) throw new Error(`TastytradePayload:invalid-${field}`)
  return parsed
}

function optionalNumber(row: JsonObject, field: string): number | undefined {
  if (row[field] === undefined || row[field] === null) return undefined
  return requiredNumber(row, field)
}

function optionalText(row: JsonObject, field: string): string | undefined {
  if (row[field] === undefined || row[field] === null) return undefined
  const parsed = jsonText(row[field])
  if (!parsed) throw new Error(`TastytradePayload:invalid-${field}`)
  return parsed
}

export function accountBalancesFromPayload(payload: JsonValue, accountNumber: string): BrokerBalances {
  const row = accountBalanceRecord(payload, accountNumber)
  if (!row) throw new Error('TastytradePayload:invalid-account-balance-record')
  return {
    availableTradingFunds: requiredNumber(row, 'available-trading-funds'),
    cashAvailableToWithdraw: requiredNumber(row, 'cash-available-to-withdraw'),
    cashBalance: requiredNumber(row, 'cash-balance'),
    dayTradingBuyingPower: requiredNumber(row, 'day-trading-buying-power'),
    derivativeBuyingPower: requiredNumber(row, 'derivative-buying-power'),
    equityBuyingPower: requiredNumber(row, 'equity-buying-power'),
    // The live figure only. It feeds the portfolio drawdown guard, so a balance that omits it
    // fails the read rather than borrowing `net-liquidating-value-snapshot`, a different field.
    netLiquidatingValue: requiredNumber(row, 'net-liquidating-value'),
  }
}

function workingOrderLeg(value: JsonValue) {
  const row = jsonObject(value)
  const action = jsonText(row?.action)
  const instrumentType = jsonText(row?.['instrument-type'])
  const quantity = jsonNumber(row?.quantity)
  const symbol = jsonText(row?.symbol)
  if (!row || !action || !instrumentType || quantity === undefined || quantity <= 0 || !symbol) {
    throw new Error('TastytradePayload:invalid-order-leg')
  }
  return { action, instrumentType, quantity, symbol }
}

function workingOrder(row: JsonObject, complexOrderId?: string): BrokerWorkingOrder {
  const orderId = id(row.id)
  const status = jsonText(row.status)
  const type = jsonText(row['order-type'])
  const rawLegs = JsonArraySchema.safeParse(row.legs).data
  if (!orderId || !status || !type || !rawLegs?.length) {
    throw new Error('TastytradePayload:invalid-working-order')
  }
  const legs = rawLegs.map(workingOrderLeg)
  const price = optionalNumber(row, 'price')
  const priceEffect = optionalText(row, 'price-effect')
  const timeInForce = optionalText(row, 'time-in-force')
  const order: BrokerWorkingOrder = { id: orderId, legs, status, symbol: legs[0]!.symbol, type }
  if (complexOrderId) order.complexOrderId = complexOrderId
  if (price !== undefined) order.price = price
  if (priceEffect) order.priceEffect = priceEffect
  if (timeInForce) order.timeInForce = timeInForce
  return order
}

export function workingOrderRecords(row: JsonObject): BrokerWorkingOrder[] {
  if (!isWorkingOrderRecord(row)) return []
  if (JsonArraySchema.safeParse(row.legs).success) return [workingOrder(row)]

  const complexOrderId = id(row.id)
  if (!complexOrderId) throw new Error('TastytradePayload:invalid-complex-order')
  const childOrders = JsonArraySchema.safeParse(row.orders).data
  if (Object.hasOwn(row, 'orders') && !childOrders) {
    throw new Error('TastytradePayload:invalid-complex-order')
  }
  const nested = (childOrders ?? []).map((value) => {
    const order = jsonObject(value)
    if (!order) throw new Error('TastytradePayload:invalid-complex-order')
    return order
  })
  if (Object.hasOwn(row, 'trigger-order')) {
    const trigger = jsonObject(row['trigger-order'])
    if (!trigger) throw new Error('TastytradePayload:invalid-complex-order')
    nested.push(trigger)
  }
  if (!nested.length) throw new Error('TastytradePayload:invalid-complex-order')
  return nested.filter(isWorkingOrderRecord).map((order) => workingOrder(order, complexOrderId))
}
