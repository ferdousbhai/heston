import {
  BrokerageActionSchema,
  previewAction,
  type BrokerageAction,
  type ChatRequest,
  type ConfirmRequest,
} from './agent-contracts'
import { planAgentReply } from './agent-planner'
import { BrokerageSubmissionUnknownError, executeBrokerageAction } from './brokerage'
import { type AppEnv, isLiveTastytrade } from './env'
import { loadMarketSnapshot } from './tastytrade'
import { answerBrokerageReadRequest, loadBrokerageContext } from './brokerage-context'
import { assertPortfolioActionAllowed, PortfolioRiskError } from './portfolio-risk'

type PendingAction = { expiresAt: string; id: string; preview: string; token: string }
export type AgentReply = { message: string; pendingAction?: PendingAction }

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

async function digest(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}

function randomToken(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

export async function preparePendingAction(env: AppEnv, action: BrokerageAction): Promise<PendingAction> {
  const id = crypto.randomUUID()
  const token = randomToken()
  const createdAt = new Date()
  const expiresAt = new Date(createdAt.getTime() + 5 * 60_000).toISOString()
  if (isLiveTastytrade(env) && !env.DB) throw new PortfolioRiskError("Dan's action store is unavailable.")
  if (env.DB && isLiveTastytrade(env)) {
    await assertPortfolioActionAllowed(env, action)
    await env.DB.prepare(
      "UPDATE brokerage_actions SET status = 'expired' WHERE status = 'pending' AND expires_at <= ?",
    ).bind(createdAt.toISOString()).run()
    if (action.kind === 'place_option_order' || action.kind === 'place_equity_order') {
      const recentTrade = await env.DB.prepare(
        `SELECT id FROM brokerage_actions
         WHERE json_extract(payload_json, '$.kind') IN ('place_option_order', 'place_equity_order')
           AND (status IN ('pending', 'executing')
             OR (status = 'executed' AND julianday(resolved_at) >= julianday('now', '-5 minutes')))
         LIMIT 1`,
      ).first<{ id: string }>()
      if (recentTrade) throw new PortfolioRiskError('Wait for the current trade and account balances to settle before drafting another trade.')
    }
    try {
      await env.DB.prepare(
        `INSERT INTO brokerage_actions (id, status, payload_json, token_digest, created_at, expires_at)
         VALUES (?, 'pending', ?, ?, ?, ?)`,
      ).bind(id, JSON.stringify(action), await digest(token), createdAt.toISOString(), expiresAt).run()
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) {
        throw new PortfolioRiskError('Resolve the existing draft before creating another brokerage action.')
      }
      throw error
    }
  }
  return { id: isLiveTastytrade(env) ? id : `demo-${id}`, token, expiresAt, preview: previewAction(action) }
}

export async function chatWithAgent(env: AppEnv, input: ChatRequest): Promise<AgentReply> {
  const snapshot = await loadMarketSnapshot(env)
  const ticker = snapshot.tickers.find((candidate) => candidate.symbol === input.selectedSymbol)
  const account = isLiveTastytrade(env) ? await loadBrokerageContext(env) : undefined
  const factualReply = account ? answerBrokerageReadRequest(input.message, account) : undefined
  if (factualReply) return { message: factualReply }
  const plan = await planAgentReply(env, input, ticker, account)
  if (!plan.action) return { message: plan.message }
  try {
    return { message: plan.message, pendingAction: await preparePendingAction(env, plan.action) }
  } catch (error) {
    if (error instanceof PortfolioRiskError) return { message: `I won't draft this trade. ${error.message}` }
    throw error
  }
}

export async function resolvePendingAction(
  env: AppEnv,
  actionId: string,
  input: ConfirmRequest,
): Promise<{ detail: string; status: 'denied' | 'executed' }> {
  if (actionId.startsWith('demo-') || !isLiveTastytrade(env)) {
    return input.decision === 'deny'
      ? { status: 'denied', detail: 'Demo action discarded' }
      : { status: 'executed', detail: 'Demo confirmed — no brokerage request was sent' }
  }
  if (!env.DB) throw new Error('Brokerage action store is unavailable')
  const row = await env.DB.prepare(
    'SELECT payload_json, token_digest, expires_at, status FROM brokerage_actions WHERE id = ?',
  ).bind(actionId).first<{ expires_at: string; payload_json: string; status: string; token_digest: string }>()
  if (!row || row.status !== 'pending') throw new Error('This action is no longer pending')
  if (Date.parse(row.expires_at) <= Date.now()) {
    await env.DB.prepare("UPDATE brokerage_actions SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(actionId).run()
    throw new Error('This confirmation has expired')
  }
  if (await digest(input.token) !== row.token_digest) throw new Error('Invalid confirmation token')
  if (input.decision === 'deny') {
    const result = await env.DB.prepare(
      "UPDATE brokerage_actions SET status = 'denied', resolved_at = ? WHERE id = ? AND status = 'pending'",
    ).bind(new Date().toISOString(), actionId).run()
    if (result.meta.changes !== 1) throw new Error('This action was already resolved')
    return { status: 'denied', detail: 'Action draft discarded' }
  }
  const claimed = await env.DB.prepare(
    "UPDATE brokerage_actions SET status = 'executing', resolved_at = ? WHERE id = ? AND status = 'pending'",
  ).bind(new Date().toISOString(), actionId).run()
  if (claimed.meta.changes !== 1) throw new Error('This action was already resolved')
  let receipt: Awaited<ReturnType<typeof executeBrokerageAction>>
  try {
    const action = BrokerageActionSchema.parse(JSON.parse(row.payload_json))
    receipt = await executeBrokerageAction(env, action)
  } catch (error) {
    if (error instanceof BrokerageSubmissionUnknownError) {
      await env.DB.prepare(
        "UPDATE brokerage_actions SET error_code = 'BrokerageSubmissionUnknown' WHERE id = ? AND status = 'executing'",
      ).bind(actionId).run()
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
    await env.DB.prepare(
      "UPDATE brokerage_actions SET error_code = 'BrokerageReceiptNotRecorded' WHERE id = ? AND status = 'executing'",
    ).bind(actionId).run().catch(() => undefined)
    throw new BrokerageSubmissionUnknownError()
  }
  return { status: 'executed', detail: receipt.detail }
}
