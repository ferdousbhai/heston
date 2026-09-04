import { type AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

import { type OrderPayload } from './order-payload'
import { type AppEnv } from './env'
import { type BrokerOrderRecord } from '../domain/broker'
import { type JsonValue } from '../domain/json-payload'
import { resolveStoredOrderFingerprint } from './order-intent'
import { brokerAdapterFor } from './brokers'
import { textResult } from './agent-tool-result'
import { BrokerCredentialMissingError, type BrokerCredential } from './broker-credential'

type StoredUnknownAction = {
  id: string
  payload_json: string
  submitted_at: string
}

/** The one unresolved ambiguous submission for this broker account, if there is one. */
export async function unresolvedSubmission(
  env: AppEnv,
  broker: string,
  accountNumber: string,
): Promise<StoredUnknownAction | null> {
  if (!env.DB) throw new Error('TastytradeReconciliation:store-unavailable')
  return env.DB.prepare(
    `SELECT id, payload_json, submitted_at
       FROM broker_submissions
      WHERE broker_id = ? AND account_number = ? AND status = 'unresolved'
      LIMIT 1`,
  ).bind(broker, accountNumber).first<StoredUnknownAction>()
}

/**
 * Record an ambiguous submission so the account stops trading until it is reconciled. The
 * stored payload is the server-resolved order, which is what the fingerprint match below needs;
 * a model-supplied one would let a wrong order clear the quarantine.
 */
export async function quarantineSubmission(
  env: AppEnv,
  submission: { accountNumber: string; broker: string; storedAction: JsonValue },
): Promise<void> {
  if (!env.DB) throw new Error('TastytradeReconciliation:store-unavailable')
  try {
    await env.DB.prepare(
      `INSERT INTO broker_submissions
         (id, broker_id, account_number, payload_json, submitted_at, status, error_code)
       VALUES (?, ?, ?, ?, ?, 'unresolved', 'BrokerageSubmissionUnknown')`,
    ).bind(
      crypto.randomUUID(),
      submission.broker,
      submission.accountNumber,
      JSON.stringify(submission.storedAction),
      new Date().toISOString(),
    ).run()
  } catch {
    // The ambiguous broker outcome is the primary failure and must still surface. Log a fixed
    // marker only: D1 and provider detail can carry private account or order context.
    console.error('BrokerageQuarantinePersistenceFailed')
  }
}

/**
 * Record an accepted submission. This is not bookkeeping for its own sake: a price-only
 * replacement resolves the original order's shape from here and then requires the broker's live
 * order to echo it, so an order this server never characterized can never be replaced.
 */
export async function recordSubmission(
  env: AppEnv,
  submission: { accountNumber: string; broker: string; providerOrderId: string; storedAction: JsonValue },
): Promise<void> {
  if (!env.DB) throw new Error('TastytradeReconciliation:store-unavailable')
  try {
    await env.DB.prepare(
      `INSERT INTO broker_submissions
         (id, broker_id, account_number, payload_json, submitted_at, status, provider_order_id)
       VALUES (?, ?, ?, ?, ?, 'executed', ?)`,
    ).bind(
      crypto.randomUUID(),
      submission.broker,
      submission.accountNumber,
      JSON.stringify(submission.storedAction),
      new Date().toISOString(),
      submission.providerOrderId,
    ).run()
  } catch {
    // The order is placed and the caller must be told so. A lost record only costs the ability
    // to replace this order by price later, which fails visibly at that point.
    console.error('BrokerageSubmissionRecordFailed')
  }
}

export type ReconciliationResult = {
  actionId?: string
  detail: string
  providerOrderId?: string
  status: 'none' | 'executed' | 'failed' | 'unresolved'
}

const ReconcileParameters = Type.Object({}, { additionalProperties: false })
// A recent absence is not proof that an ambiguous broker mutation failed; wait through the
// provider's order-history propagation window before allowing a deterministic absence result.
const FINAL_ABSENCE_DELAY_MS = 15 * 60_000
function sameLeg(actual: NonNullable<BrokerOrderRecord['legs']>[number], intended: OrderPayload['legs'][number]): boolean {
  return Boolean(actual)
    && actual!.action === intended.action
    && actual!.instrumentType === intended['instrument-type']
    && actual!.quantity === intended.quantity
    && actual!.symbol === intended.symbol
}

/** Exact order fingerprint match; timestamps keep unrelated duplicate orders from clearing quarantine. */
export function matchesSubmittedOrder(
  row: BrokerOrderRecord,
  intended: OrderPayload,
  submittedAt: Date,
  now = new Date(),
  replacedOrderId?: string,
): boolean {
  const legs = row.legs
  if (legs?.length !== intended.legs.length) return false
  const receivedAt = Date.parse(row.receivedAt ?? row.updatedAt ?? '')
  if (!Number.isFinite(receivedAt)
    || receivedAt < submittedAt.getTime() - 2 * 60_000
    || receivedAt > now.getTime() + 60_000) return false
  return (!replacedOrderId || row.replacesOrderId === replacedOrderId)
    && row.orderType === intended['order-type']
    && row.timeInForce === intended['time-in-force']
    && row.priceEffect === intended['price-effect']
    && row.price === Number(intended.price)
    && legs.every((leg, index) => sameLeg(leg, intended.legs[index]!))
}

export async function reconcileUnknownBrokerageAction(
  env: AppEnv,
  credential: BrokerCredential | undefined,
  now = new Date(),
): Promise<ReconciliationResult> {
  if (!credential) throw new BrokerCredentialMissingError()
  if (!env.DB) throw new Error('TastytradeReconciliation:store-unavailable')
  // Scoped to the account the presented credential resolves to: a member may only reconcile
  // their own quarantine, and possession of a row id is never authority to touch it.
  const adapter = brokerAdapterFor(credential)
  const ref = await adapter.resolveAccountRef(env, credential)
  const stored = await unresolvedSubmission(env, credential.broker, ref.accountNumber)
  if (!stored) return { detail: 'No brokerage submission needs reconciliation.', status: 'none' }

  const submittedAt = new Date(stored.submitted_at)
  if (!Number.isFinite(submittedAt.getTime())) {
    return { actionId: stored.id, detail: 'The local submission timestamp is invalid; the quarantine remains in place.', status: 'unresolved' }
  }
  const fingerprint = await resolveStoredOrderFingerprint(env, JSON.parse(stored.payload_json))
  const intended = fingerprint.payload
  const replacedOrderId = fingerprint.action.kind === 'replace_order' ? fingerprint.action.orderId : undefined
  const startDate = new Date(submittedAt.getTime() - 24 * 60 * 60_000).toISOString().slice(0, 10)
  const history = await adapter.readOrderHistory(env, ref, { startDate }, credential)
  const matches = history.orders.filter((row) => matchesSubmittedOrder(row, intended, submittedAt, now, replacedOrderId))
  if (matches.length !== 1) {
    if (matches.length === 0 && history.complete && now.getTime() - submittedAt.getTime() >= FINAL_ABSENCE_DELAY_MS) {
      const update = await env.DB.prepare(
        "UPDATE broker_submissions SET status = 'failed', error_code = 'BrokerageSubmissionNotFound' WHERE id = ? AND status = 'unresolved'",
      ).bind(stored.id).run()
      if (update.meta.changes === 1) {
        return { actionId: stored.id, detail: 'No matching broker order appeared after the reconciliation window.', status: 'failed' }
      }
    }
    const reason = matches.length > 1 ? 'More than one exact broker match was found.' : 'No exact broker match is visible yet.'
    return { actionId: stored.id, detail: `${reason} The quarantine remains in place.`, status: 'unresolved' }
  }

  const match = matches[0]!
  const providerOrderId = match.id
  const status = match.status?.toLowerCase()
  if (!providerOrderId || !status) throw new Error('TastytradeReconciliation:invalid-match')
  const rejected = status === 'rejected'
  // provider_order_id is not stored: the quarantine only needs to know the submission is
  // settled, and the broker's own history is authoritative for the order itself.
  const update = await env.DB.prepare(rejected
    ? "UPDATE broker_submissions SET status = 'failed', error_code = 'TastytradeOrderRejected' WHERE id = ? AND status = 'unresolved'"
    : "UPDATE broker_submissions SET status = 'executed', error_code = NULL WHERE id = ? AND status = 'unresolved'"
  ).bind(stored.id).run()
  if (update.meta.changes !== 1) {
    return { actionId: stored.id, detail: 'The action was already reconciled by another request.', status: 'unresolved' }
  }
  return {
    actionId: stored.id,
    detail: rejected ? `Broker order #${providerOrderId} was rejected.` : `Broker order #${providerOrderId} was found and recorded.`,
    providerOrderId,
    status: rejected ? 'failed' : 'executed',
  }
}

export function createBrokerageReconciliationTool(
  env: AppEnv,
  credential: BrokerCredential | undefined,
): AgentTool<typeof ReconcileParameters, ReconciliationResult> {
  return {
    description: 'Resolve one quarantined submission against broker order history. Use this after '
      + 'an ambiguous submission; never automatically retry an ambiguous broker mutation.',
    execute: async () => textResult(await reconcileUnknownBrokerageAction(env, credential)),
    executionMode: 'sequential',
    label: 'Reconciling order',
    name: 'reconcile_brokerage_action',
    parameters: ReconcileParameters,
  }
}
