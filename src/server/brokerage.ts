import { OrderPlacementSchema } from './agent-contracts'
import { type AppEnv } from './env'
import { resolveEquityOptionContract } from './option-contract'
import { assertPortfolioActionAllowed } from './portfolio-risk'
import { resolveAccountNumber, tastyRequest } from './tastytrade'
import { assertOrderMarketSafe } from './order-market'

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

type OrderPayload = {
  'advanced-instructions'?: {
    'strict-position-effect-validation': true
  }
  'order-type': 'Limit'
  'price-effect': 'Credit' | 'Debit'
  'time-in-force': 'Day'
  legs: Array<{
    action: string
    'instrument-type': 'Equity' | 'Equity Option'
    quantity: number
    symbol: string
  }>
  price: string
}

export function buildOrderPayload(
  action: ReturnType<typeof OrderPlacementSchema.parse>,
  resolvedSymbol: string,
): OrderPayload {
  return {
    ...(action.action.endsWith('to Close')
      ? { 'advanced-instructions': { 'strict-position-effect-validation': true as const } }
      : {}),
    'order-type': 'Limit',
    'price-effect': action.priceEffect,
    'time-in-force': 'Day',
    legs: [{
      action: action.action,
      'instrument-type': action.kind === 'place_option_order' ? 'Equity Option' : 'Equity',
      quantity: action.quantity,
      symbol: resolvedSymbol,
    }],
    price: action.limitPrice.toFixed(2),
  }
}

function messageRows(value: unknown): Record<string, unknown>[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'object' || item === null || Array.isArray(item))) {
    throw new Error('TastytradeOrderResponse:invalid-messages')
  }
  return value as Record<string, unknown>[]
}

function messageText(row: Record<string, unknown>, fallback: string): string {
  const value = row.message ?? row.code
  if (typeof value !== 'string' || !value.trim()) throw new Error('TastytradeOrderResponse:invalid-message')
  return value.trim().slice(0, 160) || fallback
}

export function validateOrderResponse(
  payload: unknown,
  intended: OrderPayload,
  requireOrderId: boolean,
): { id?: string; warnings: string[] } {
  const body = record(payload)
  const data = record(body.data ?? body)
  const errors = messageRows(data.errors ?? body.errors).slice(0, 5)
  if (errors.length) {
    const message = errors.map((error) => messageText(error, 'Order rejected')).join('; ')
    throw new TastytradeOrderRejectedError(message.slice(0, 160))
  }
  const warnings = messageRows(data.warnings ?? body.warnings).slice(0, 5)
    .map((warning) => messageText(warning, 'Broker warning'))
  const order = record(data.order ?? body.order)
  const buyingPower = record(data['buying-power-effect'] ?? body['buying-power-effect'])
  if (!Object.keys(order).length || !Object.keys(buyingPower).length) {
    throw new Error('TastytradeOrderResponse:missing-order-or-buying-power')
  }
  const echoedLegs = rows(order.legs)
  const echoedPrice = Number(order.price)
  const buyingPowerEffect = String(buyingPower.effect ?? '')
  const echoesIntent = order['order-type'] === intended['order-type']
    && order['time-in-force'] === intended['time-in-force']
    && Number.isFinite(echoedPrice)
    && Math.abs(echoedPrice - Number(intended.price)) < 1e-9
    && buyingPowerEffect === intended['price-effect']
    && echoedLegs.length === intended.legs.length
    && intended.legs.every((leg, index) => {
      const echoed = echoedLegs[index]
      return echoed?.action === leg.action
        && echoed?.['instrument-type'] === leg['instrument-type']
        && echoed?.symbol === leg.symbol
        && Number(echoed?.quantity) === leg.quantity
    })
  if (!echoesIntent) throw new Error('TastytradeOrderResponse:echo-mismatch')
  const id = order.id === undefined || order.id === null ? undefined : String(order.id)
  const validId = id && /^\d{1,40}$/.test(id) ? id : undefined
  if (requireOrderId && !validId) throw new BrokerageSubmissionUnknownError()
  return { id: validId, warnings }
}

export class BrokerageSubmissionUnknownError extends Error {
  constructor() {
    super('Tastytrade may have received this order, but Spice could not verify the result. Reconciliation is required before another trade.')
    this.name = 'BrokerageSubmissionUnknownError'
  }
}

export class TastytradeOrderRejectedError extends Error {
  constructor(message: string) {
    super(`TastytradeOrderRejected:${message}`)
    this.name = 'TastytradeOrderRejectedError'
  }
}

export class TastytradeOrderWarningError extends Error {
  constructor(warnings: readonly string[]) {
    super(`Tastytrade returned a preflight warning, so the order was not submitted: ${warnings.join('; ')}`)
    this.name = 'TastytradeOrderWarningError'
  }
}

export function rejectDryRunWarnings(warnings: readonly string[]): void {
  if (warnings.length) throw new TastytradeOrderWarningError(warnings)
}

/** Once placement returned 2xx, anything short of a verified rejection or exact receipt is ambiguous. */
export function validatePlacedOrderResponse(payload: unknown, intended: OrderPayload): { id: string; warnings: string[] } {
  try {
    const result = validateOrderResponse(payload, intended, true)
    return { id: result.id!, warnings: result.warnings }
  } catch (error) {
    if (error instanceof TastytradeOrderRejectedError) throw error
    throw new BrokerageSubmissionUnknownError()
  }
}

export async function executeOrderPlacement(env: AppEnv, untrustedAction: unknown): Promise<{ detail: string; orderId?: string }> {
  const action = OrderPlacementSchema.parse(untrustedAction)
  const account = await resolveAccountNumber(env)
  const optionContract = action.kind === 'place_option_order' ? await resolveEquityOptionContract(env, action) : undefined
  await assertPortfolioActionAllowed(env, action, { accountNumber: account, optionContract })
  await assertOrderMarketSafe(env, action, optionContract)
  const symbol = action.kind === 'place_option_order' ? optionContract!.symbol : action.symbol
  const payload = buildOrderPayload(action, symbol)
  const dryRun = await tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders/dry-run`, { method: 'POST', body: JSON.stringify(payload) })
  rejectDryRunWarnings(validateOrderResponse(dryRun, payload, false).warnings)
  let placed: unknown
  try {
    placed = await tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders`, { method: 'POST', body: JSON.stringify(payload) })
  } catch (error) {
    if (error instanceof Error && error.name === 'TastytradeApiError') throw error
    throw new BrokerageSubmissionUnknownError()
  }
  const receipt = validatePlacedOrderResponse(placed, payload)
  const warningDetail = receipt.warnings.length ? ` Broker warning: ${receipt.warnings.join('; ')}` : ''
  return { detail: `Order #${receipt.id} accepted by tastytrade.${warningDetail}`, orderId: receipt.id }
}
