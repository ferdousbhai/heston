import { type AppEnv } from './env'
import { BROKER_ORDER_ID } from '../domain/broker'
import {
  JsonObjectArraySchema,
  jsonObjectOrEmpty,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { type OrderPlacement } from './agent-contracts'
import { claimSubmission, settleSubmission } from './brokerage-reconciliation'
import { resolveOrderIntent, type ResolvedOrderIntent } from './order-intent'
import { echoesOrderPayload, replacementOrderPayload, type OrderPayload } from './order-payload'
import { tastytradeOrderRecord } from './brokers/tastytrade'
import { brokerApi } from './tastytrade'
import { tradeGuards } from './trade-guards'
import { OwnerVisibleError } from './owner-visible-error'
import { BrokerCredentialMissingError, type BrokerCredential } from './broker-credential'

export type OrderResponseReceipt = { id?: string; warnings: string[] }
export type PlacedOrderReceipt = { id: string; warnings: string[] }
export type ReplacementReceipt = { id: string }

// Broker messages are untrusted presentation text. Preserve a small diagnostic packet without
// allowing a rejection body to dominate logs, stored errors, or the agent response.
const MAX_BROKER_MESSAGE_LENGTH = 160
const MAX_BROKER_MESSAGES_PER_KIND = 5

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
  // Only the presence of a buying-power effect is required: it is a different fact from the
  // order's price effect. A Buy to Close debit on a short frees margin, so its buying-power
  // effect is a Credit, and requiring the two to agree refused exactly the risk-reducing orders.
  if (!echoesOrderPayload(tastytradeOrderRecord(order), intended)) {
    throw new Error('TastytradeOrderResponse:echo-mismatch')
  }
  const id = order.id === undefined || order.id === null ? undefined : String(order.id)
  return { id: id && BROKER_ORDER_ID.test(id) ? id : undefined, warnings }
}

export class BrokerageSubmissionUnknownError extends OwnerVisibleError {
  constructor() {
    super('ambiguous-brokerage', 'Tastytrade may have received this order, but Heston could not verify the result. Reconciliation is required before another trade.')
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
    const record = tastytradeOrderRecord(order)
    const exact = BROKER_ORDER_ID.test(id)
      && record.replacesOrderId === replacedOrderId
      && echoesOrderPayload(record, intended)
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

type SubmissionReceipt = { detail: string; orderId: string }

export type PlacementOutcome = SubmissionReceipt & { intent: ResolvedOrderIntent }

/**
 * Resolve, guard, dry-run, and submit one order under the account's mutation lease.
 *
 * The account number and the intent are resolved once, by the caller and inside the lease
 * respectively; `onResolved` runs at the point the intent becomes exact, before any guard.
 */
export async function executeOrderPlacement(
  env: AppEnv,
  action: OrderPlacement,
  credential: BrokerCredential | undefined,
  accountNumber: string,
  onResolved: (intent: ResolvedOrderIntent) => Promise<void> = async () => undefined,
): Promise<PlacementOutcome> {
  if (!credential) throw new BrokerCredentialMissingError()
  const broker = credential.broker
  return brokerApi().withBrokerMutationLease(env, accountNumber, async (lease) => {
    const intent = await resolveOrderIntent(env, action, accountNumber, credential)
    await onResolved(intent)
    await tradeGuards().assertPortfolioActionAllowed(env, intent.effectiveAction, credential, {
      accountNumber,
      optionContracts: intent.optionContracts,
    })
    await tradeGuards().assertOrderMarketSafe(env, intent.effectiveAction, intent.optionContracts)
    const account = encodeURIComponent(accountNumber)
    const orderPath = intent.replaceOrderId
      ? `/accounts/${account}/orders/${encodeURIComponent(intent.replaceOrderId)}`
      : `/accounts/${account}/orders`
    const body = JSON.stringify(intent.replaceOrderId ? replacementOrderPayload(intent.payload) : intent.payload)
    await lease.renew()
    const dryRun = await brokerApi().tastyRequest(
      env,
      `${orderPath}/dry-run`,
      { method: 'POST', body },
      credential,
    )
    rejectDryRunWarnings(validateOrderResponse(dryRun, intent.payload).warnings)
    // Everything that can fail without sending anything happens before the claim and the try
    // below: a lost lease here is a plain failure, never an ambiguous submission.
    await lease.renew()
    const submissionId = await claimSubmission(env, { accountNumber, broker, storedAction: intent.storedAction })
    let placed: JsonValue
    try {
      placed = await brokerApi().tastyRequest(env, orderPath, {
        method: intent.replaceOrderId ? 'PUT' : 'POST',
        body,
      }, credential)
    } catch (error) {
      // A provider 4xx: the broker positively refused the request, so nothing was placed.
      if (error instanceof Error && error.name === 'TastytradeApiError') {
        await settleSubmission(env, submissionId, { errorCode: 'TastytradeApiError', status: 'failed' })
        throw error
      }
      // Ambiguous: the claimed row stays `unresolved`, which is the quarantine.
      throw new BrokerageSubmissionUnknownError()
    }
    let receipt: SubmissionReceipt
    try {
      if (intent.replaceOrderId) {
        const replaced = validateReplacementReceipt(placed, intent.replaceOrderId, intent.payload)
        receipt = { detail: `Order #${intent.replaceOrderId} replaced by order #${replaced.id}.`, orderId: replaced.id }
      } else {
        const accepted = validatePlacedOrderResponse(placed, intent.payload)
        const warningDetail = accepted.warnings.length ? ` Broker warning: ${accepted.warnings.join('; ')}` : ''
        receipt = { detail: `Order #${accepted.id} accepted by tastytrade.${warningDetail}`, orderId: accepted.id }
      }
    } catch (error) {
      if (error instanceof TastytradeOrderRejectedError) {
        await settleSubmission(env, submissionId, { errorCode: 'TastytradeOrderRejected', status: 'failed' })
      }
      throw error
    }
    const settled = await settleSubmission(env, submissionId, { providerOrderId: receipt.orderId, status: 'executed' })
    // The order is placed and the caller must be told so. An unrecorded settlement only keeps
    // the account quarantined until reconciliation finds this order in broker history.
    const detail = settled
      ? receipt.detail
      : `${receipt.detail} Heston could not record this result, so this account stays quarantined until reconcile_brokerage_action confirms it.`
    return { detail, intent, orderId: receipt.orderId }
  })
}
