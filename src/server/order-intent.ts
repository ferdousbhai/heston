import {
  FreshOrderPlacementSchema,
  StoredOrderPlacementSchema,
  type FreshOrderPlacement,
  type OrderPlacement,
  type StoredOrderPlacement,
} from './agent-contracts'
import { type AppEnv } from './env'
import { type JsonValue } from '../domain/json-payload'
import { type BrokerOrderRecord } from '../domain/broker'
import { brokerAdapterFor } from './brokers'
import { buildOrderPayload, echoesOrderPayload, type OrderPayload } from './order-payload'
import {
  resolveEquityOptionContract,
  resolveEquityOptionTuples,
  type EquityOptionContract,
} from './option-contract'
import { type BrokerCredential } from './broker-credential'
import { CallerVisibleError } from './caller-visible-error'

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
    throw new CallerVisibleError('OrderIntent:spread-multiplier-mismatch')
  }
  return {
    optionContracts: contracts,
    payload: buildOrderPayload(action, contracts.map((contract) => contract.symbol)),
  }
}

const TERMINAL_ORDER_STATUSES = ['cancelled', 'expired', 'filled', 'rejected', 'removed']

/** The shared echo, plus: nothing on it has filled, so the whole order is still working. */
function sameOrderEcho(order: BrokerOrderRecord, intended: OrderPayload): boolean {
  return echoesOrderPayload(order, intended)
    && (order.legs ?? []).every((leg) => leg?.remainingQuantity === leg?.quantity
      && (leg?.fillCount === undefined || leg.fillCount === 0))
}

export function assertReplaceableOrder(order: BrokerOrderRecord, orderId: string, intended: OrderPayload): void {
  const status = order.status?.toLowerCase()
  if (order.id !== orderId
    || !order.editable
    || !status
    || TERMINAL_ORDER_STATUSES.includes(status)
    || order.terminalAt
    || !sameOrderEcho(order, intended)) {
    throw new CallerVisibleError('OrderReplacement:order-changed-or-not-editable')
  }
}

async function sourceOrderAction(env: AppEnv, orderId: string): Promise<StoredOrderPlacement> {
  if (!env.DB) throw new CallerVisibleError('OrderReplacement:action-store-unavailable')
  const result = await env.DB.prepare(
    `SELECT payload_json FROM broker_submissions
      WHERE provider_order_id = ? AND status = 'executed'
      ORDER BY submitted_at DESC LIMIT 2`,
  ).bind(orderId).all<{ payload_json: string }>()
  const rows = result.results ?? []
  if (rows.length !== 1) throw new CallerVisibleError('OrderReplacement:source-order-not-found')
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
  const adapter = brokerAdapterFor(credential)
  const current = await adapter.readOrder(
    env,
    { accountNumber, broker: adapter.id },
    action.orderId,
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

/** Build the exact submitted fingerprint for reconciliation without requiring the replaced order to remain live. */
export async function resolveStoredOrderFingerprint(
  env: AppEnv,
  untrustedAction: JsonValue,
): Promise<{ action: StoredOrderPlacement; payload: OrderPayload }> {
  const action = StoredOrderPlacementSchema.parse(untrustedAction)
  const resolved = await resolveFreshOrder(env, effectiveStoredOrder(action))
  return { action, payload: resolved.payload }
}
