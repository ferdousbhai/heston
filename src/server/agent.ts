import {
  OrderPlacementSchema,
  previewAction,
  type FreshOrderPlacement,
  type OrderPlacement,
  type ConfirmRequest,
} from './agent-contracts'
import { BrokerageSubmissionUnknownError, executeOrderPlacement } from './brokerage'
import { reconcileUnknownBrokerageAction } from './brokerage-reconciliation'
import { type JsonValue } from '../domain/json-payload'
import { type PendingAction } from '../domain/agent-chat'
import { type AppEnv } from './env'
import { PortfolioRiskError } from './portfolio-risk'
import { resolveOrderIntent } from './order-intent'
import { orderMarketPreview } from './order-market'
import { tradeGuards } from './trade-guards'
import { brokerApi } from './tastytrade'
import { internalWatchlistWriter } from './internal-watchlist'
import { OwnerVisibleError } from './owner-visible-error'

type CloudflareSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView): boolean
}

export class PendingActionStateError extends OwnerVisibleError {
  constructor(readonly reason: 'expired' | 'not-pending') {
    super('action-state', reason === 'expired' ? 'This confirmation has expired' : 'This action is no longer pending')
    this.name = 'PendingActionStateError'
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

async function digest(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

async function timingSafeDigestMatch(provided: string, expected: string): Promise<boolean> {
  // SAFETY: Cloudflare Workers extends the standard SubtleCrypto implementation with
  // timingSafeEqual; this module runs only in that Worker runtime outside test stubs.
  const subtle = crypto.subtle as CloudflareSubtleCrypto
  const encoder = new TextEncoder()
  const [providedHash, expectedHash] = await Promise.all([
    subtle.digest('SHA-256', encoder.encode(provided)),
    subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  return subtle.timingSafeEqual(providedHash, expectedHash)
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

export async function rememberTradeIntentSymbol(env: AppEnv, action: FreshOrderPlacement): Promise<void> {
  const symbol = action.kind === 'place_equity_order' ? action.symbol : action.underlying
  await internalWatchlistWriter().ensureSymbols(env, [symbol], 'trade-intent')
}

export async function preparePendingAction(env: AppEnv, untrustedAction: JsonValue): Promise<PendingAction> {
  const action: OrderPlacement = OrderPlacementSchema.parse(untrustedAction)
  const id = crypto.randomUUID()
  const token = randomToken()
  const createdAt = new Date()
  const expiresAt = new Date(createdAt.getTime() + 5 * 60_000).toISOString()
  if (!env.DB) throw new PortfolioRiskError("Dan's action store is unavailable.")
  await reconcileUnknownBrokerageAction(env)
  const accountNumber = await brokerApi().resolveAccountNumber(env)
  const intent = await resolveOrderIntent(env, action, accountNumber)
  // Exact contract/order resolution is the deterministic point where a discussed
  // trade becomes a trusted ticker, including price-only replacements.
  await rememberTradeIntentSymbol(env, intent.effectiveAction)
  await tradeGuards().assertPortfolioActionAllowed(env, intent.effectiveAction, {
    accountNumber,
    ignoredOrderId: intent.replaceOrderId,
    optionContracts: intent.optionContracts,
  })
  const marketPreview = orderMarketPreview(await tradeGuards().assertOrderMarketSafe(env, intent.effectiveAction, intent.optionContracts))
  await env.DB.prepare(
    "UPDATE brokerage_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
  ).bind(createdAt.toISOString()).run()
  const recentTrade = await env.DB.prepare(
    `SELECT id FROM brokerage_actions
       WHERE (status IN ('pending', 'executing')
           OR (status = 'executed' AND julianday(resolved_at) >= julianday('now', '-5 minutes')))
       LIMIT 1`,
  ).first<{ id: string }>()
  if (recentTrade) throw new PortfolioRiskError('Wait for the current trade and account balances to settle before drafting another trade.')
  try {
    await env.DB.prepare(
      `INSERT INTO brokerage_actions (id, status, payload_json, token_digest, created_at, expires_at)
       VALUES (?, 'pending', ?, ?, ?, ?)`,
    ).bind(id, JSON.stringify(intent.storedAction), await digest(token), createdAt.toISOString(), expiresAt).run()
  } catch (error) {
    if (error instanceof Error && error.message.includes('UNIQUE')) {
      throw new PortfolioRiskError('Resolve the existing draft before creating another brokerage action.')
    }
    throw error
  }
  const preview = `${previewAction(action)} · ${marketPreview}`
  return { id, token, expiresAt, preview }
}

export async function resolvePendingAction(
  env: AppEnv,
  actionId: string,
  input: ConfirmRequest,
): Promise<{ detail: string; status: 'denied' | 'executed' }> {
  if (!env.DB) throw new Error('Brokerage action store is unavailable')
  const row = await env.DB.prepare(
    'SELECT payload_json, token_digest, expires_at, status FROM brokerage_actions WHERE id = ?',
  ).bind(actionId).first<{ expires_at: string; payload_json: string; status: string; token_digest: string }>()
  if (!row || row.status !== 'pending') throw new PendingActionStateError('not-pending')
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.DB.prepare("UPDATE brokerage_actions SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(actionId).run()
    throw new PendingActionStateError('expired')
  }
  if (!await timingSafeDigestMatch(await digest(input.token), row.token_digest)) {
    throw new Error('Invalid confirmation token')
  }
  if (input.decision === 'deny') {
    const result = await env.DB.prepare(
      "UPDATE brokerage_actions SET status = 'denied', resolved_at = ? WHERE id = ? AND status = 'pending'",
    ).bind(new Date().toISOString(), actionId).run()
    if (result.meta.changes !== 1) throw new PendingActionStateError('not-pending')
    return { status: 'denied', detail: 'Action draft discarded' }
  }
  const claimed = await env.DB.prepare(
    "UPDATE brokerage_actions SET status = 'executing', resolved_at = ? WHERE id = ? AND status = 'pending'",
  ).bind(new Date().toISOString(), actionId).run()
  if (claimed.meta.changes !== 1) throw new PendingActionStateError('not-pending')
  let receipt: Awaited<ReturnType<typeof executeOrderPlacement>>
  try {
    receipt = await executeOrderPlacement(env, JSON.parse(row.payload_json))
  } catch (error) {
    if (error instanceof BrokerageSubmissionUnknownError) {
      try {
        const marked = await env.DB.prepare(
          "UPDATE brokerage_actions SET error_code = 'BrokerageSubmissionUnknown' WHERE id = ? AND status = 'executing'",
        ).bind(actionId).run()
        if (marked.meta.changes !== 1) console.error('BrokerageUnknownMarkerPersistenceFailed')
      } catch {
        // The broker outcome remains the primary failure. Log only a fixed marker:
        // D1/provider details can carry private account or order context.
        console.error('BrokerageUnknownMarkerPersistenceFailed')
      }
    } else {
      await env.DB.prepare(
        "UPDATE brokerage_actions SET status = 'failed', error_code = ? WHERE id = ? AND status = 'executing'",
      ).bind(error instanceof Error ? error.message.slice(0, 160) : 'BrokerageDispatchFailed', actionId).run()
    }
    throw error
  }
  try {
    const recorded = await env.DB.prepare(
      "UPDATE brokerage_actions SET status = 'executed', provider_order_id = ? WHERE id = ? AND status = 'executing'",
    ).bind(receipt.orderId ?? null, actionId).run()
    if (recorded.meta.changes !== 1) throw new Error('BrokerageReceiptNotRecorded')
  } catch {
    try {
      const marked = await env.DB.prepare(
        "UPDATE brokerage_actions SET error_code = 'BrokerageReceiptNotRecorded' WHERE id = ? AND status = 'executing'",
      ).bind(actionId).run()
      if (marked.meta.changes !== 1) console.error('BrokerageReceiptMarkerPersistenceFailed')
    } catch {
      console.error('BrokerageReceiptMarkerPersistenceFailed')
    }
    throw new BrokerageSubmissionUnknownError()
  }
  return { status: 'executed', detail: receipt.detail }
}
