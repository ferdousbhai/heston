import { type AgentTool } from '@earendil-works/pi-agent-core'
import { Type } from 'typebox'

import { type OrderPayload } from './order-payload'
import { type AppEnv } from './env'
import {
  envelopeRows,
  envelopeTotalItems,
  JsonArraySchema,
  jsonLooseText,
  jsonNumber,
  jsonObject,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { resolveStoredOrderFingerprint } from './order-intent'
import { brokerApi } from './tastytrade'
import { textResult } from './agent-tool-result'
import { BrokerCredentialMissingError, type BrokerCredential } from './broker-credential'

type StoredUnknownAction = {
  error_code: string | null
  id: string
  payload_json: string
  resolved_at: string
}

type OrderHistoryPage = { complete: boolean; rows: JsonObject[] }

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
const RECONCILIATION_HISTORY_PAGE_SIZE = 100

/** Whether the broker claimed a total at all, as opposed to one we could not read. */
function declaresTotalItems(payload: JsonValue): boolean {
  const body = jsonObject(payload)
  const pagination = jsonObject(body?.pagination) ?? jsonObject(jsonObject(body?.data)?.pagination)
  return pagination?.['total-items'] !== undefined
}

function orderRows(payload: JsonValue): OrderHistoryPage {
  const candidate = envelopeRows(payload)
  if (!candidate || candidate.length > RECONCILIATION_HISTORY_PAGE_SIZE) {
    throw new Error('TastytradeReconciliation:invalid-history')
  }
  const rows = candidate.map((value) => {
    const row = jsonObject(value)
    if (!row) throw new Error('TastytradeReconciliation:invalid-history')
    return row
  })
  // The history request asks for 100 rows, so a page that did not fill is the
  // whole history. A broker that reports a total we cannot read is not evidence
  // of completeness: staying incomplete keeps an ambiguous mutation quarantined
  // rather than concluding the order is absent.
  const total = envelopeTotalItems(payload)
  const complete = total !== undefined
    ? total <= rows.length
    : !declaresTotalItems(payload) && rows.length < RECONCILIATION_HISTORY_PAGE_SIZE
  return { complete, rows }
}

function sameLeg(actual: JsonObject, intended: OrderPayload['legs'][number]): boolean {
  return jsonLooseText(actual.action) === intended.action
    && jsonLooseText(actual['instrument-type']) === intended['instrument-type']
    && jsonNumber(actual.quantity) === intended.quantity
    && jsonLooseText(actual.symbol) === intended.symbol
}

/** Exact order fingerprint match; timestamps keep unrelated duplicate orders from clearing quarantine. */
export function matchesSubmittedOrder(
  row: JsonObject,
  intended: OrderPayload,
  submittedAt: Date,
  now = new Date(),
  replacedOrderId?: string,
): boolean {
  const legs = JsonArraySchema.safeParse(row.legs).data
  if (legs?.length !== intended.legs.length) return false
  const receivedAt = Date.parse(jsonLooseText(row['received-at']) ?? jsonLooseText(row['updated-at']) ?? '')
  if (!Number.isFinite(receivedAt)
    || receivedAt < submittedAt.getTime() - 2 * 60_000
    || receivedAt > now.getTime() + 60_000) return false
  return (!replacedOrderId || jsonLooseText(row['replaces-order-id']) === replacedOrderId)
    && jsonLooseText(row['order-type']) === intended['order-type']
    && jsonLooseText(row['time-in-force']) === intended['time-in-force']
    && jsonLooseText(row['price-effect']) === intended['price-effect']
    && jsonNumber(row.price) === Number(intended.price)
    && legs.every((leg, index) => {
      const actual = jsonObject(leg)
      return Boolean(actual && sameLeg(actual, intended.legs[index]!))
    })
}

export async function reconcileUnknownBrokerageAction(
  env: AppEnv,
  credential: BrokerCredential | undefined,
  now = new Date(),
): Promise<ReconciliationResult> {
  if (!credential) throw new BrokerCredentialMissingError()
  if (!env.DB) throw new Error('TastytradeReconciliation:store-unavailable')
  const staleBefore = new Date(now.getTime() - 2 * 60_000).toISOString()
  const stored = await env.DB.prepare(
    `SELECT id, payload_json, resolved_at, error_code
       FROM brokerage_actions
      WHERE status = 'executing'
        AND (error_code IN ('BrokerageSubmissionUnknown', 'BrokerageReceiptNotRecorded')
          OR resolved_at <= ?)
      ORDER BY resolved_at ASC
      LIMIT 1`,
  ).bind(staleBefore).first<StoredUnknownAction>()
  if (!stored) return { detail: 'No brokerage submission needs reconciliation.', status: 'none' }

  const submittedAt = new Date(stored.resolved_at)
  if (!Number.isFinite(submittedAt.getTime())) {
    return { actionId: stored.id, detail: 'The local submission timestamp is invalid; the quarantine remains in place.', status: 'unresolved' }
  }
  const [account, fingerprint] = await Promise.all([
    brokerApi().resolveAccountNumber(env, credential),
    resolveStoredOrderFingerprint(env, JSON.parse(stored.payload_json)),
  ])
  const intended = fingerprint.payload
  const replacedOrderId = fingerprint.action.kind === 'replace_order' ? fingerprint.action.orderId : undefined
  const startDate = new Date(submittedAt.getTime() - 24 * 60 * 60_000).toISOString().slice(0, 10)
  const history = orderRows(await brokerApi().tastyRequest(
    env,
    `/accounts/${encodeURIComponent(account)}/orders?per-page=${RECONCILIATION_HISTORY_PAGE_SIZE}&sort=Desc&start-date=${startDate}`,
    {},
    credential,
  ))
  const matches = history.rows.filter((row) => matchesSubmittedOrder(row, intended, submittedAt, now, replacedOrderId))
  if (matches.length !== 1) {
    if (matches.length === 0 && history.complete && now.getTime() - submittedAt.getTime() >= FINAL_ABSENCE_DELAY_MS) {
      const update = await env.DB.prepare(
        "UPDATE brokerage_actions SET status = 'failed', error_code = 'BrokerageSubmissionNotFound' WHERE id = ? AND status = 'executing'",
      ).bind(stored.id).run()
      if (update.meta.changes === 1) {
        return { actionId: stored.id, detail: 'No matching broker order appeared after the reconciliation window.', status: 'failed' }
      }
    }
    const reason = matches.length > 1 ? 'More than one exact broker match was found.' : 'No exact broker match is visible yet.'
    return { actionId: stored.id, detail: `${reason} The quarantine remains in place.`, status: 'unresolved' }
  }

  const match = matches[0]!
  const providerOrderId = jsonLooseText(match.id)
  const status = jsonLooseText(match.status)?.toLowerCase()
  if (!providerOrderId || !status) throw new Error('TastytradeReconciliation:invalid-match')
  const rejected = status === 'rejected'
  const update = await env.DB.prepare(rejected
    ? "UPDATE brokerage_actions SET status = 'failed', provider_order_id = ?, error_code = 'TastytradeOrderRejected' WHERE id = ? AND status = 'executing'"
    : "UPDATE brokerage_actions SET status = 'executed', provider_order_id = ?, error_code = NULL WHERE id = ? AND status = 'executing'"
  ).bind(providerOrderId, stored.id).run()
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
    description: 'Resolve one quarantined submission against broker order history.',
    execute: async () => textResult(await reconcileUnknownBrokerageAction(env, credential)),
    executionMode: 'sequential',
    label: 'Reconciling order',
    name: 'reconcile_brokerage_action',
    parameters: ReconcileParameters,
  }
}
