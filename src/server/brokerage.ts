import { type AppEnv } from './env'
import { resolveStoredOrderIntent } from './order-intent'
import { replacementOrderPayload, type OrderPayload } from './order-payload'
import { assertPortfolioActionAllowed } from './portfolio-risk'
import { resolveAccountNumber, tastyRequest } from './tastytrade'
import { assertOrderMarketSafe } from './order-market'

export { buildOrderPayload } from './order-payload'

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
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

export function validateReplacementReceipt(
  payload: unknown,
  replacedOrderId: string,
  intended: OrderPayload,
): { id: string } {
  try {
    const body = record(payload)
    const order = record(body.data ?? body)
    const id = String(order.id ?? '')
    const legs = rows(order.legs)
    const exact = /^\d{1,40}$/.test(id)
      && String(order['replaces-order-id'] ?? '') === replacedOrderId
      && order['order-type'] === intended['order-type']
      && order['time-in-force'] === intended['time-in-force']
      && order['price-effect'] === intended['price-effect']
      && Number(order.price) === Number(intended.price)
      && legs.length === intended.legs.length
      && intended.legs.every((leg, index) => {
        const actual = legs[index]
        return actual?.action === leg.action
          && actual?.['instrument-type'] === leg['instrument-type']
          && actual?.symbol === leg.symbol
          && Number(actual?.quantity) === leg.quantity
      })
    if (!exact) throw new Error('TastytradeReplacementResponse:echo-mismatch')
    return { id }
  } catch {
    throw new BrokerageSubmissionUnknownError()
  }
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
  const account = await resolveAccountNumber(env)
  const intent = await resolveStoredOrderIntent(env, untrustedAction, account)
  await assertPortfolioActionAllowed(env, intent.effectiveAction, {
    accountNumber: account,
    ignoredOrderId: intent.replaceOrderId,
    optionContracts: intent.optionContracts,
  })
  await assertOrderMarketSafe(env, intent.effectiveAction, intent.optionContracts)
  const dryRunPath = intent.replaceOrderId
    ? `/accounts/${encodeURIComponent(account)}/orders/${encodeURIComponent(intent.replaceOrderId)}/dry-run`
    : `/accounts/${encodeURIComponent(account)}/orders/dry-run`
  const dryRunBody = intent.replaceOrderId ? replacementOrderPayload(intent.payload) : intent.payload
  const dryRun = await tastyRequest(env, dryRunPath, { method: 'POST', body: JSON.stringify(dryRunBody) })
  rejectDryRunWarnings(validateOrderResponse(dryRun, intent.payload, false).warnings)
  let placed: unknown
  try {
    const path = intent.replaceOrderId
      ? `/accounts/${encodeURIComponent(account)}/orders/${encodeURIComponent(intent.replaceOrderId)}`
      : `/accounts/${encodeURIComponent(account)}/orders`
    const body = intent.replaceOrderId
      ? JSON.stringify(replacementOrderPayload(intent.payload))
      : JSON.stringify(intent.payload)
    placed = await tastyRequest(env, path, {
      method: intent.replaceOrderId ? 'PUT' : 'POST',
      body,
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TastytradeApiError') throw error
    throw new BrokerageSubmissionUnknownError()
  }
  if (intent.replaceOrderId) {
    const receipt = validateReplacementReceipt(placed, intent.replaceOrderId, intent.payload)
    return { detail: `Order #${intent.replaceOrderId} replaced by order #${receipt.id}.`, orderId: receipt.id }
  }
  const receipt = validatePlacedOrderResponse(placed, intent.payload)
  const warningDetail = receipt.warnings.length ? ` Broker warning: ${receipt.warnings.join('; ')}` : ''
  return { detail: `Order #${receipt.id} accepted by tastytrade.${warningDetail}`, orderId: receipt.id }
}
