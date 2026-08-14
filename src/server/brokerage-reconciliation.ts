import { Type } from '@earendil-works/pi-ai'
import { type AgentTool } from '@earendil-works/pi-agent-core'

import { type OrderPayload } from './order-payload'
import { type AppEnv, isLiveTastytrade } from './env'
import { resolveStoredOrderFingerprint } from './order-intent'
import { resolveAccountNumber, tastyRequest } from './tastytrade'

type JsonRecord = Record<string, unknown>
type StoredUnknownAction = {
  error_code: string | null
  id: string
  payload_json: string
  resolved_at: string
}

export type ReconciliationResult = {
  actionId?: string
  detail: string
  providerOrderId?: string
  status: 'none' | 'executed' | 'failed' | 'unresolved'
}

const ReconcileParameters = Type.Object({}, { additionalProperties: false })
const FINAL_ABSENCE_DELAY_MS = 15 * 60_000

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const result = String(value).trim()
  return result ? result : undefined
}

function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const result = Number(value)
  return Number.isFinite(result) ? result : undefined
}

function orderRows(payload: unknown): { complete: boolean; rows: JsonRecord[] } {
  const body = record(payload)
  const rawData = body?.data ?? payload
  const data = record(rawData)
  const candidate = Array.isArray(rawData) ? rawData : data?.items ?? body?.items
  if (!Array.isArray(candidate) || candidate.length > 100) throw new Error('TastytradeReconciliation:invalid-history')
  const rows = candidate.map((value) => record(value) ?? (() => { throw new Error('TastytradeReconciliation:invalid-history') })())
  const pagination = record(body?.pagination) ?? record(data?.pagination)
  const total = number(pagination?.['total-items'])
  const complete = total === undefined ? rows.length < 100 : Number.isSafeInteger(total) && total <= rows.length
  return { complete, rows }
}

function sameLeg(actual: JsonRecord, intended: OrderPayload['legs'][number]): boolean {
  return text(actual.action) === intended.action
    && text(actual['instrument-type']) === intended['instrument-type']
    && number(actual.quantity) === intended.quantity
    && text(actual.symbol) === intended.symbol
}

/** Exact order fingerprint match; timestamps keep unrelated duplicate orders from clearing quarantine. */
export function matchesSubmittedOrder(
  row: JsonRecord,
  intended: OrderPayload,
  submittedAt: Date,
  now = new Date(),
  replacedOrderId?: string,
): boolean {
  if (!Array.isArray(row.legs) || row.legs.length !== intended.legs.length) return false
  const receivedAt = Date.parse(text(row['received-at']) ?? text(row['updated-at']) ?? '')
  if (!Number.isFinite(receivedAt)
    || receivedAt < submittedAt.getTime() - 2 * 60_000
    || receivedAt > now.getTime() + 60_000) return false
  return (!replacedOrderId || text(row['replaces-order-id']) === replacedOrderId)
    && text(row['order-type']) === intended['order-type']
    && text(row['time-in-force']) === intended['time-in-force']
    && text(row['price-effect']) === intended['price-effect']
    && number(row.price) === Number(intended.price)
    && row.legs.every((leg, index) => {
      const actual = record(leg)
      return Boolean(actual && sameLeg(actual, intended.legs[index]!))
    })
}

export async function reconcileUnknownBrokerageAction(
  env: AppEnv,
  now = new Date(),
): Promise<ReconciliationResult> {
  if (!isLiveTastytrade(env) || !env.DB) {
    return { detail: 'Live brokerage reconciliation is unavailable.', status: 'none' }
  }
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
    resolveAccountNumber(env),
    resolveStoredOrderFingerprint(env, JSON.parse(stored.payload_json)),
  ])
  const intended = fingerprint.payload
  const replacedOrderId = fingerprint.action.kind === 'replace_order' ? fingerprint.action.orderId : undefined
  const startDate = new Date(submittedAt.getTime() - 24 * 60 * 60_000).toISOString().slice(0, 10)
  const history = orderRows(await tastyRequest(
    env,
    `/accounts/${encodeURIComponent(account)}/orders?per-page=100&sort=Desc&start-date=${startDate}`,
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
  const providerOrderId = text(match.id)
  const status = text(match.status)?.toLowerCase()
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

export function createBrokerageReconciliationTool(env: AppEnv): AgentTool<typeof ReconcileParameters, ReconciliationResult> {
  return {
    description: 'Reconcile a quarantined, ambiguous Spice order submission against recent tastytrade history. This never submits or retries an order.',
    execute: async () => {
      const result = await reconcileUnknownBrokerageAction(env)
      return { content: [{ text: JSON.stringify(result), type: 'text' }], details: result }
    },
    label: 'Reconciling order',
    name: 'reconcile_brokerage_action',
    parameters: ReconcileParameters,
  }
}
