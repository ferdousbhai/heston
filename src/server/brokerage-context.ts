import { type AppEnv } from './env'
import { type BrokerCredential } from './broker-credential'
import { brokerApi } from './tastytrade'
import {
  accountBalancesFromPayload,
  BROKER_ACCOUNT_PAGE_SIZE,
  completeAccountRows,
  type AccountBalances,
  type WorkingOrder,
  workingOrderRecords,
} from './tastytrade-payload'

import {
  jsonNumber,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'

export interface BrokerageContext {
  accountNumber: string
  asOf: string
  balances: AccountBalances
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
}

type BrokeragePosition = BrokerageContext['positions'][number]

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

function positionFromRecord(row: JsonObject): BrokerageContext['positions'][number] | undefined {
  const symbol = jsonText(row.symbol)
  const underlying = jsonText(row['underlying-symbol'])?.toUpperCase()
  const quantity = jsonNumber(row.quantity)
  const direction = jsonText(row['quantity-direction'])
  const instrumentType = jsonText(row['instrument-type'])
  if (!symbol
    || !underlying
    || quantity === undefined
    || quantity < 0
    || (direction !== 'Long' && direction !== 'Short')
    || !instrumentType) {
    throw new Error('TastytradeAccount:invalid-position')
  }
  if (quantity === 0) return undefined
  const averageOpenPrice = jsonNumber(row['average-open-price'])
  if (row['average-open-price'] !== undefined && row['average-open-price'] !== null
    && averageOpenPrice === undefined) throw new Error('TastytradeAccount:invalid-position-average-open-price')
  const rawExpiry = jsonText(row['expires-at'])
  if (row['expires-at'] !== undefined && row['expires-at'] !== null
    && (!rawExpiry || !Number.isFinite(Date.parse(rawExpiry)))) {
    throw new Error('TastytradeAccount:invalid-position-expiry')
  }
  const expiresAt = rawExpiry
  const position: BrokeragePosition = { direction, instrumentType, quantity, symbol, underlying }
  if (averageOpenPrice !== undefined) position.averageOpenPrice = averageOpenPrice
  if (expiresAt) position.expiresAt = expiresAt
  return position
}

function parsedPositions(payload: JsonValue): BrokeragePosition[] {
  return completeAccountRows(payload, 'positions').flatMap((row) => {
    const position = positionFromRecord(row)
    return position ? [position] : []
  })
}

function parsedOrders(
  ordinaryPayload: JsonValue,
  complexPayload: JsonValue,
): WorkingOrder[] {
  const normalized = [
    ...completeAccountRows(ordinaryPayload, 'orders'),
    ...completeAccountRows(complexPayload, 'complex-orders'),
  ].flatMap(workingOrderRecords)
  return [...new Map(normalized.map((order) => [order.id, order])).values()]
}

export async function loadBrokerageContext(
  env: AppEnv,
  credential?: BrokerCredential,
): Promise<BrokerageContext> {
  const account = await brokerApi().resolveAccountNumber(env, credential)
  const [positionPayload, balancePayload, orderPayload, complexOrderPayload] = await Promise.all([
    brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/positions?per-page=${BROKER_ACCOUNT_PAGE_SIZE}`, {}, credential),
    brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/balances`, {}, credential),
    brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders/live?per-page=${BROKER_ACCOUNT_PAGE_SIZE}`, {}, credential),
    brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/complex-orders/live?per-page=${BROKER_ACCOUNT_PAGE_SIZE}`, {}, credential),
  ])
  return {
    accountNumber: account,
    asOf: new Date().toISOString(),
    source: 'tastytrade',
    balances: accountBalancesFromPayload(balancePayload, account),
    positions: parsedPositions(positionPayload),
    orders: parsedOrders(orderPayload, complexOrderPayload),
  }
}

export function buildAgentRuntimeContext(context: BrokerageContext) {
  return {
    asOf: context.asOf,
    source: context.source,
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
}
