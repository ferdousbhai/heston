import {
  FreshOrderPlacementSchema,
  OrderPlacementSchema,
  StoredOrderPlacementSchema,
  type FreshOrderPlacement,
  type OrderPlacement,
  type StoredOrderPlacement,
} from './agent-contracts'
import { type AppEnv } from './env'
import { buildOrderPayload, type OrderPayload } from './order-payload'
import {
  resolveEquityOptionContract,
  resolveEquityOptionTuples,
  type EquityOptionContract,
} from './option-contract'
import { tastyRequest } from './tastytrade'

type JsonRecord = Record<string, unknown>

export type ResolvedOrderIntent = {
  effectiveAction: FreshOrderPlacement
  optionContracts: EquityOptionContract[]
  payload: OrderPayload
  replaceOrderId?: string
  storedAction: StoredOrderPlacement
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const result = String(value).trim()
  return result || undefined
}

function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const result = Number(value)
  return Number.isFinite(result) ? result : undefined
}

export function effectiveStoredOrder(action: StoredOrderPlacement): FreshOrderPlacement {
  return action.kind === 'replace_order' ? action.replacementOrder : action
}

async function resolveFreshOrder(
  env: AppEnv,
  action: FreshOrderPlacement,
): Promise<{ optionContracts: EquityOptionContract[]; payload: OrderPayload }> {
  if (action.kind === 'place_equity_order') {
    return { optionContracts: [], payload: buildOrderPayload(action, [action.symbol]) }
  }
  if (action.kind === 'place_option_order') {
    const contract = await resolveEquityOptionContract(env, action)
    return { optionContracts: [contract], payload: buildOrderPayload(action, [contract.symbol]) }
  }
  const contracts = await resolveEquityOptionTuples(env, [
    { underlying: action.underlying, expiry: action.expiry, optionType: action.optionType, strike: action.longStrike },
    { underlying: action.underlying, expiry: action.expiry, optionType: action.optionType, strike: action.shortStrike },
  ], { opening: true })
  if (contracts[0]!.sharesPerContract !== contracts[1]!.sharesPerContract) {
    throw new Error('OrderIntent:spread-multiplier-mismatch')
  }
  return {
    optionContracts: contracts,
    payload: buildOrderPayload(action, contracts.map((contract) => contract.symbol)),
  }
}

function exactOrder(payload: unknown): JsonRecord {
  const body = record(payload)
  const data = record(body?.data ?? payload)
  if (!data || Array.isArray(data.items)) throw new Error('OrderReplacement:invalid-order')
  return data
}

function sameOrderEcho(order: JsonRecord, intended: OrderPayload): boolean {
  const legs = order.legs
  if (text(order['order-type']) !== intended['order-type']
    || text(order['time-in-force']) !== intended['time-in-force']
    || text(order['price-effect']) !== intended['price-effect']
    || number(order.price) !== Number(intended.price)
    || !Array.isArray(legs)
    || legs.length !== intended.legs.length) return false
  return intended.legs.every((leg, index) => {
    const actual = record(legs[index])
    if (!actual || text(actual.action) !== leg.action
      || text(actual['instrument-type']) !== leg['instrument-type']
      || text(actual.symbol) !== leg.symbol
      || number(actual.quantity) !== leg.quantity
      || number(actual['remaining-quantity']) !== leg.quantity) return false
    return !Array.isArray(actual.fills) || actual.fills.length === 0
  })
}

export function assertReplaceableOrder(payload: unknown, orderId: string, intended: OrderPayload): void {
  const order = exactOrder(payload)
  const status = text(order.status)?.toLowerCase()
  if (text(order.id) !== orderId
    || order.editable !== true
    || !status
    || ['cancelled', 'expired', 'filled', 'rejected', 'removed'].includes(status)
    || text(order['terminal-at'])
    || !sameOrderEcho(order, intended)) {
    throw new Error('OrderReplacement:order-changed-or-not-editable')
  }
}

async function sourceOrderAction(env: AppEnv, orderId: string): Promise<StoredOrderPlacement> {
  if (!env.DB) throw new Error('OrderReplacement:action-store-unavailable')
  const result = await env.DB.prepare(
    `SELECT payload_json FROM brokerage_actions
      WHERE provider_order_id = ? AND status = 'executed'
      ORDER BY resolved_at DESC LIMIT 2`,
  ).bind(orderId).all<{ payload_json: string }>()
  const rows = result.results ?? []
  if (rows.length !== 1) throw new Error('OrderReplacement:source-order-not-found')
  return StoredOrderPlacementSchema.parse(JSON.parse(rows[0]!.payload_json))
}

async function expandReplacement(
  env: AppEnv,
  action: Extract<OrderPlacement, { kind: 'replace_order' }>,
  accountNumber: string,
): Promise<ResolvedOrderIntent> {
  const source = effectiveStoredOrder(await sourceOrderAction(env, action.orderId))
  const sourceResolved = await resolveFreshOrder(env, source)
  const current = await tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/orders/${encodeURIComponent(action.orderId)}`)
  assertReplaceableOrder(current, action.orderId, sourceResolved.payload)
  const replacementOrder = FreshOrderPlacementSchema.parse({ ...source, limitPrice: action.limitPrice })
  const replacementResolved = await resolveFreshOrder(env, replacementOrder)
  return {
    effectiveAction: replacementOrder,
    optionContracts: replacementResolved.optionContracts,
    payload: replacementResolved.payload,
    replaceOrderId: action.orderId,
    storedAction: { ...action, replacementOrder },
  }
}

export async function resolveOrderIntent(
  env: AppEnv,
  untrustedAction: unknown,
  accountNumber: string,
): Promise<ResolvedOrderIntent> {
  const action = OrderPlacementSchema.parse(untrustedAction)
  if (action.kind === 'replace_order') return expandReplacement(env, action, accountNumber)
  const resolved = await resolveFreshOrder(env, action)
  return { effectiveAction: action, ...resolved, storedAction: action }
}

/** Revalidate a stored confirmation draft without trusting its embedded replacement details. */
export async function resolveStoredOrderIntent(
  env: AppEnv,
  untrustedAction: unknown,
  accountNumber: string,
): Promise<ResolvedOrderIntent> {
  const stored = StoredOrderPlacementSchema.parse(untrustedAction)
  if (stored.kind !== 'replace_order') return resolveOrderIntent(env, stored, accountNumber)
  const expanded = await expandReplacement(env, stored, accountNumber)
  if (JSON.stringify(expanded.effectiveAction) !== JSON.stringify(stored.replacementOrder)) {
    throw new Error('OrderReplacement:draft-no-longer-matches')
  }
  return { ...expanded, storedAction: stored }
}

/** Build the exact submitted fingerprint for reconciliation without requiring the replaced order to remain live. */
export async function resolveStoredOrderFingerprint(
  env: AppEnv,
  untrustedAction: unknown,
): Promise<{ action: StoredOrderPlacement; payload: OrderPayload }> {
  const action = StoredOrderPlacementSchema.parse(untrustedAction)
  const resolved = await resolveFreshOrder(env, effectiveStoredOrder(action))
  return { action, payload: resolved.payload }
}
