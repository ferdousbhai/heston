import { Type } from '@earendil-works/pi-ai'
import { type AgentTool } from '@earendil-works/pi-agent-core'

import { type OrderPayload } from './order-payload'
import { type AppEnv } from './env'
import {
  JsonArraySchema,
  JsonObjectSchema,
  LooseTextSchema,
  NumericSchema,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { resolveStoredOrderFingerprint } from './order-intent'
import { brokerApi } from './tastytrade'

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
const FINAL_ABSENCE_DELAY_MS = 15 * 60_000

function text(value: JsonValue): string | undefined {
  return LooseTextSchema.safeParse(value).data
}

function number(value: JsonValue): number | undefined {
  return NumericSchema.safeParse(value).data
}

function orderRows(payload: JsonValue): OrderHistoryPage {
  const body = JsonObjectSchema.safeParse(payload).data
  const rawData = body?.data ?? payload
  const data = JsonObjectSchema.safeParse(rawData).data
  const candidate = JsonArraySchema.safeParse(rawData).data
    ?? JsonArraySchema.safeParse(data?.items ?? body?.items).data
  if (!candidate || candidate.length > 100) throw new Error('TastytradeReconciliation:invalid-history')
  const rows = candidate.map((value) => {
    const row = JsonObjectSchema.safeParse(value).data
    if (!row) throw new Error('TastytradeReconciliation:invalid-history')
    return row
  })
  const pagination = JsonObjectSchema.safeParse(body?.pagination).data
    ?? JsonObjectSchema.safeParse(data?.pagination).data
  const total = number(pagination?.['total-items'])
  const complete = total === undefined ? rows.length < 100 : Number.isSafeInteger(total) && total <= rows.length
  return { complete, rows }
}

function sameLeg(actual: JsonObject, intended: OrderPayload['legs'][number]): boolean {
  return text(actual.action) === intended.action
    && text(actual['instrument-type']) === intended['instrument-type']
    && number(actual.quantity) === intended.quantity
    && text(actual.symbol) === intended.symbol
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
  const receivedAt = Date.parse(text(row['received-at']) ?? text(row['updated-at']) ?? '')
  if (!Number.isFinite(receivedAt)
    || receivedAt < submittedAt.getTime() - 2 * 60_000
    || receivedAt > now.getTime() + 60_000) return false
  return (!replacedOrderId || text(row['replaces-order-id']) === replacedOrderId)
    && text(row['order-type']) === intended['order-type']
    && text(row['time-in-force']) === intended['time-in-force']
    && text(row['price-effect']) === intended['price-effect']
    && number(row.price) === Number(intended.price)
    && legs.every((leg, index) => {
      const actual = JsonObjectSchema.safeParse(leg).data
      return Boolean(actual && sameLeg(actual, intended.legs[index]!))
    })
}

export async function reconcileUnknownBrokerageAction(
  env: AppEnv,
  now = new Date(),
): Promise<ReconciliationResult> {
  if (!env.DB) {
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
    brokerApi().resolveAccountNumber(env),
    resolveStoredOrderFingerprint(env, JSON.parse(stored.payload_json)),
  ])
  const intended = fingerprint.payload
  const replacedOrderId = fingerprint.action.kind === 'replace_order' ? fingerprint.action.orderId : undefined
  const startDate = new Date(submittedAt.getTime() - 24 * 60 * 60_000).toISOString().slice(0, 10)
  const history = orderRows(await brokerApi().tastyRequest(
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
