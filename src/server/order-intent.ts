import {
  FreshOrderPlacementSchema,
  StoredOrderPlacementSchema,
  type FreshOrderPlacement,
  type OrderPlacement,
  type StoredOrderPlacement,
} from './agent-contracts'
import { type AppEnv } from './env'
import {
  JsonArraySchema,
  jsonLooseText,
  jsonNumber,
  jsonObject,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { buildOrderPayload, type OrderPayload } from './order-payload'
import {
  resolveEquityOptionContract,
  resolveEquityOptionTuples,
  type EquityOptionContract,
} from './option-contract'
import { brokerApi } from './tastytrade'
import { type BrokerCredential } from './broker-credential'

export type ResolvedOrderIntent = {
  effectiveAction: FreshOrderPlacement
  optionContracts: EquityOptionContract[]
  payload: OrderPayload
  replaceOrderId?: string
  storedAction: StoredOrderPlacement
}

function effectiveStoredOrder(action: StoredOrderPlacement): FreshOrderPlacement {
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

function exactOrder(payload: JsonValue): JsonObject {
  const body = jsonObject(payload)
  const data = jsonObject(body?.data ?? payload)
  if (!data || JsonArraySchema.safeParse(data.items).success) throw new Error('OrderReplacement:invalid-order')
  return data
}

function sameOrderEcho(order: JsonObject, intended: OrderPayload): boolean {
  const legs = JsonArraySchema.safeParse(order.legs).data
  if (jsonLooseText(order['order-type']) !== intended['order-type']
    || jsonLooseText(order['time-in-force']) !== intended['time-in-force']
    || jsonLooseText(order['price-effect']) !== intended['price-effect']
    || jsonNumber(order.price) !== Number(intended.price)
    || legs?.length !== intended.legs.length) return false
  return intended.legs.every((leg, index) => {
    const actual = jsonObject(legs[index])
    if (!actual || jsonLooseText(actual.action) !== leg.action
      || jsonLooseText(actual['instrument-type']) !== leg['instrument-type']
      || jsonLooseText(actual.symbol) !== leg.symbol
      || jsonNumber(actual.quantity) !== leg.quantity
      || jsonNumber(actual['remaining-quantity']) !== leg.quantity) return false
    const fills = JsonArraySchema.safeParse(actual.fills).data
    return !fills || fills.length === 0
  })
}

export function assertReplaceableOrder(payload: JsonValue, orderId: string, intended: OrderPayload): void {
  const order = exactOrder(payload)
  const status = jsonLooseText(order.status)?.toLowerCase()
  if (jsonLooseText(order.id) !== orderId
    || order.editable !== true
    || !status
    || ['cancelled', 'expired', 'filled', 'rejected', 'removed'].includes(status)
    || jsonLooseText(order['terminal-at'])
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
  credential: BrokerCredential | undefined,
): Promise<ResolvedOrderIntent> {
  const source = effectiveStoredOrder(await sourceOrderAction(env, action.orderId))
  const sourceResolved = await resolveFreshOrder(env, source)
  const current = await brokerApi().tastyRequest(
    env,
    `/accounts/${encodeURIComponent(accountNumber)}/orders/${encodeURIComponent(action.orderId)}`,
    {},
    credential,
  )
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
  action: OrderPlacement,
  accountNumber: string,
  credential: BrokerCredential | undefined,
): Promise<ResolvedOrderIntent> {
  if (action.kind === 'replace_order') return expandReplacement(env, action, accountNumber, credential)
  const resolved = await resolveFreshOrder(env, action)
  return { effectiveAction: action, ...resolved, storedAction: action }
}

/** Revalidate a stored confirmation draft without trusting its embedded replacement details. */
export async function resolveStoredOrderIntent(
  env: AppEnv,
  untrustedAction: JsonValue,
  accountNumber: string,
  credential: BrokerCredential | undefined,
): Promise<ResolvedOrderIntent> {
  const stored = StoredOrderPlacementSchema.parse(untrustedAction)
  if (stored.kind !== 'replace_order') return resolveOrderIntent(env, stored, accountNumber, credential)
  const expanded = await expandReplacement(env, stored, accountNumber, credential)
  if (JSON.stringify(expanded.effectiveAction) !== JSON.stringify(stored.replacementOrder)) {
    throw new Error('OrderReplacement:draft-no-longer-matches')
  }
  return { ...expanded, storedAction: stored }
}

/** Build the exact submitted fingerprint for reconciliation without requiring the replaced order to remain live. */
export async function resolveStoredOrderFingerprint(
  env: AppEnv,
  untrustedAction: JsonValue,
): Promise<{ action: StoredOrderPlacement; payload: OrderPayload }> {
  const action = StoredOrderPlacementSchema.parse(untrustedAction)
  const resolved = await resolveFreshOrder(env, effectiveStoredOrder(action))
  return { action, payload: resolved.payload }
}
