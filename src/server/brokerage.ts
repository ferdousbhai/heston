import { type AppEnv } from './env'
import {
  JsonArraySchema,
  jsonObject,
  JsonObjectArraySchema,
  jsonObjectOrEmpty,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { resolveStoredOrderIntent } from './order-intent'
import { replacementOrderPayload, type OrderPayload } from './order-payload'
import { brokerApi } from './tastytrade'
import { tradeGuards } from './trade-guards'
import { OwnerVisibleError } from './owner-visible-error'
import { type BrokerCredential } from './broker-credential'

export type OrderResponseReceipt = { id?: string; warnings: string[] }
export type PlacedOrderReceipt = { id: string; warnings: string[] }
export type ReplacementReceipt = { id: string }

// Broker messages are untrusted presentation text. Preserve a small diagnostic packet without
// allowing a rejection body to dominate logs, stored errors, or the agent response.
const MAX_BROKER_MESSAGE_LENGTH = 160
const MAX_BROKER_MESSAGES_PER_KIND = 5

function rows(value: JsonValue): JsonObject[] {
  const items = JsonArraySchema.safeParse(value).data
  if (!items) throw new Error('TastytradeOrderResponse:invalid-order-legs')
  return items.map((row) => {
    const parsed = jsonObject(row)
    if (!parsed) throw new Error('TastytradeOrderResponse:invalid-order-leg')
    return parsed
  })
}

function messageRows(value: JsonValue): JsonObject[] {
  if (value === undefined || value === null) return []
  const items = JsonObjectArraySchema.safeParse(value).data
  if (!items) throw new Error('TastytradeOrderResponse:invalid-messages')
  return items
}

function messageText(row: JsonObject): string {
  const value = jsonText(row.message ?? row.code)
  if (value === undefined) throw new Error('TastytradeOrderResponse:invalid-message')
  return value.length > MAX_BROKER_MESSAGE_LENGTH
    ? `${value.slice(0, MAX_BROKER_MESSAGE_LENGTH - 1)}…`
    : value
}

function messagePacket(value: JsonValue, kind: string): string[] {
  const messages = messageRows(value)
  const selected = messages.slice(0, MAX_BROKER_MESSAGES_PER_KIND).map(messageText)
  const omitted = messages.length - selected.length
  return omitted ? [...selected, `${omitted} more broker ${kind} omitted`] : selected
}

export function validateOrderResponse(payload: JsonValue, intended: OrderPayload): OrderResponseReceipt {
  const body = jsonObjectOrEmpty(payload)
  const data = jsonObjectOrEmpty(body.data ?? body)
  const errors = messagePacket(data.errors ?? body.errors, 'errors')
  if (errors.length) {
    throw new TastytradeOrderRejectedError(errors.join('; '))
  }
  const warnings = messagePacket(data.warnings ?? body.warnings, 'warnings')
  const order = jsonObjectOrEmpty(data.order ?? body.order)
  const buyingPower = jsonObjectOrEmpty(data['buying-power-effect'] ?? body['buying-power-effect'])
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
  return { id: id && /^\d{1,40}$/.test(id) ? id : undefined, warnings }
}

export class BrokerageSubmissionUnknownError extends OwnerVisibleError {
  constructor() {
    super('ambiguous-brokerage', 'Tastytrade may have received this order, but Spice could not verify the result. Reconciliation is required before another trade.')
    this.name = 'BrokerageSubmissionUnknownError'
  }
}

class TastytradeOrderRejectedError extends Error {
  constructor(message: string) {
    super(`TastytradeOrderRejected:${message}`)
    this.name = 'TastytradeOrderRejectedError'
  }
}

export class TastytradeOrderWarningError extends OwnerVisibleError {
  constructor(warnings: readonly string[]) {
    super('broker-warning', `Tastytrade returned a preflight warning, so the order was not submitted: ${warnings.join('; ')}`)
    this.name = 'TastytradeOrderWarningError'
  }
}

export function rejectDryRunWarnings(warnings: readonly string[]): void {
  if (warnings.length) throw new TastytradeOrderWarningError(warnings)
}

export function validateReplacementReceipt(
  payload: JsonValue,
  replacedOrderId: string,
  intended: OrderPayload,
): ReplacementReceipt {
  try {
    const body = jsonObjectOrEmpty(payload)
    const order = jsonObjectOrEmpty(body.data ?? body)
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
export function validatePlacedOrderResponse(payload: JsonValue, intended: OrderPayload): PlacedOrderReceipt {
  let receipt: OrderResponseReceipt
  try {
    receipt = validateOrderResponse(payload, intended)
  } catch (error) {
    if (error instanceof TastytradeOrderRejectedError) throw error
    throw new BrokerageSubmissionUnknownError()
  }
  // A 2xx placement without a usable broker order id is ambiguous, never a success.
  if (!receipt.id) throw new BrokerageSubmissionUnknownError()
  return { id: receipt.id, warnings: receipt.warnings }
}

export async function executeOrderPlacement(
  env: AppEnv,
  untrustedAction: JsonValue,
  credential: BrokerCredential | undefined,
): Promise<{ detail: string; orderId?: string }> {
  const account = await brokerApi().resolveAccountNumber(env, credential)
  return brokerApi().withBrokerMutationLease(env, account, async (lease) => {
    const intent = await resolveStoredOrderIntent(env, untrustedAction, account, credential)
    await tradeGuards().assertPortfolioActionAllowed(env, intent.effectiveAction, credential, {
      accountNumber: account,
      ignoredOrderId: intent.replaceOrderId,
      optionContracts: intent.optionContracts,
    })
    await tradeGuards().assertOrderMarketSafe(env, intent.effectiveAction, intent.optionContracts)
    const dryRunPath = intent.replaceOrderId
      ? `/accounts/${encodeURIComponent(account)}/orders/${encodeURIComponent(intent.replaceOrderId)}/dry-run`
      : `/accounts/${encodeURIComponent(account)}/orders/dry-run`
    const dryRunBody = intent.replaceOrderId ? replacementOrderPayload(intent.payload) : intent.payload
    await lease.renew()
    const dryRun = await brokerApi().tastyRequest(
      env,
      dryRunPath,
      { method: 'POST', body: JSON.stringify(dryRunBody) },
      credential,
    )
    rejectDryRunWarnings(validateOrderResponse(dryRun, intent.payload).warnings)
    let placed: JsonValue
    try {
      const path = intent.replaceOrderId
        ? `/accounts/${encodeURIComponent(account)}/orders/${encodeURIComponent(intent.replaceOrderId)}`
        : `/accounts/${encodeURIComponent(account)}/orders`
      const body = intent.replaceOrderId
        ? JSON.stringify(replacementOrderPayload(intent.payload))
        : JSON.stringify(intent.payload)
      await lease.renew()
      placed = await brokerApi().tastyRequest(env, path, {
        method: intent.replaceOrderId ? 'PUT' : 'POST',
        body,
      }, credential)
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
  })
}
