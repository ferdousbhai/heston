import { type AgentTool } from '../domain/agent-tool'
import { Type } from 'typebox'

import { type OrderPayload } from './order-payload'
import { type AppEnv } from './env'
import { type BrokerOrderRecord, type BrokerOrderRecordLeg } from '../domain/broker'
import { type JsonValue } from '../domain/json-payload'
import { resolveStoredOrderFingerprint } from './order-intent'
import { brokerAdapterFor } from './brokers'
import { textResult } from './agent-tool-result'
import { BrokerCredentialMissingError, type BrokerCredential } from './broker-credential'
import { PortfolioRiskError } from './portfolio-risk'

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
 * The write-ahead record of one submission, and with it the quarantine check.
 *
 * It is written inside the mutation lease, after the broker dry-run and before the POST or PUT
 * leaves, as `unresolved`. The partial unique index `broker_submissions_one_unresolved_per_account`
 * makes this insert the atomic "is this account quarantined?" test: a second placement whose
 * insert conflicts is refused, and so is one whose insert fails for any other reason, because an
 * order sent without this row could go ambiguous with nothing to stop the next one. Checking
 * first and writing after the broker answered left a window -- the lease is not held across both
 * -- in which a concurrent placement could slip through before the quarantine landed.
 *
 * The stored payload is the server-resolved order, which is what the reconciliation fingerprint
 * needs; a model-supplied one would let a wrong order clear the quarantine.
 */
export async function claimSubmission(
  env: AppEnv,
  submission: { accountNumber: string; broker: string; storedAction: JsonValue },
): Promise<string> {
  if (!env.DB) throw new PortfolioRiskError('The brokerage submission store is unavailable, so nothing was submitted.')
  const id = crypto.randomUUID()
  try {
    await env.DB.prepare(
      `INSERT INTO broker_submissions
         (id, broker_id, account_number, payload_json, submitted_at, status, error_code)
       VALUES (?, ?, ?, ?, ?, 'unresolved', 'BrokerageSubmissionUnknown')`,
    ).bind(
      id,
      submission.broker,
      submission.accountNumber,
      JSON.stringify(submission.storedAction),
      new Date().toISOString(),
    ).run()
    return id
  } catch {
    // Either refusal is safe; the lookup only chooses which one the caller reads. A lookup that
    // itself fails falls to the store refusal, never to submitting.
    const quarantined = await unresolvedSubmission(env, submission.broker, submission.accountNumber)
      .catch(() => null)
    if (quarantined) {
      throw new PortfolioRiskError(
        'A previous submission for this account could not be verified and is still unresolved. '
        + 'Reconcile it against broker order history before placing another order; do not retry the previous one.',
      )
    }
    // A fixed marker only: D1 detail can carry private account or order context.
    console.error('BrokerageSubmissionClaimFailed')
    throw new PortfolioRiskError('The brokerage submission could not be recorded, so nothing was submitted.')
  }
}

export type SubmissionOutcome =
  | { providerOrderId: string; status: 'executed' }
  | { errorCode: 'TastytradeApiError' | 'TastytradeOrderRejected'; status: 'failed' }

/**
 * Settle a claimed submission once the broker's answer is definite. Returns whether the row
 * moved. A write that fails leaves the row `unresolved`, which is the safe direction: the
 * account stays quarantined until reconciliation settles it from broker order history, rather
 * than being released on a result nothing recorded. An ambiguous answer is never settled here.
 */
export async function settleSubmission(env: AppEnv, id: string, outcome: SubmissionOutcome): Promise<boolean> {
  try {
    if (!env.DB) throw new Error('TastytradeReconciliation:store-unavailable')
    const statement = outcome.status === 'executed'
      ? env.DB.prepare(
        "UPDATE broker_submissions SET status = 'executed', error_code = NULL, provider_order_id = ? WHERE id = ? AND status = 'unresolved'",
      ).bind(outcome.providerOrderId, id)
      : env.DB.prepare(
        "UPDATE broker_submissions SET status = 'failed', error_code = ? WHERE id = ? AND status = 'unresolved'",
      ).bind(outcome.errorCode, id)
    const update = await statement.run()
    if (update.meta.changes === 1) return true
  } catch {
    // Fall through to the fixed marker below.
  }
  console.error('BrokerageSubmissionSettleFailed')
  return false
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
// `submitted_at` is the write-ahead claim, taken before the request leaves, so the window runs
// from no later than the send. A claimed row whose request never left at all (a transport
// failure before sending is still treated as ambiguous) is covered the same way: it stays
// quarantined until this window passes with a complete history and no match.
const FINAL_ABSENCE_DELAY_MS = 15 * 60_000
function sameLeg(actual: BrokerOrderRecordLeg | undefined, intended: OrderPayload['legs'][number]): boolean {
  if (!actual) return false
  return actual.action === intended.action
    && actual.instrumentType === intended['instrument-type']
    && actual.quantity === intended.quantity
    && actual.symbol === intended.symbol
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
  // An executed match stores the broker's order id: this row is the only source a later
  // price-only replacement can resolve the order's shape from, exactly as if the placement had
  // settled it directly.
  const update = await (rejected
    ? env.DB.prepare(
      "UPDATE broker_submissions SET status = 'failed', error_code = 'TastytradeOrderRejected' WHERE id = ? AND status = 'unresolved'",
    ).bind(stored.id)
    : env.DB.prepare(
      "UPDATE broker_submissions SET status = 'executed', error_code = NULL, provider_order_id = ? WHERE id = ? AND status = 'unresolved'",
    ).bind(providerOrderId, stored.id)
  ).run()
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
