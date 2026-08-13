import { BrokerageActionSchema } from './agent-contracts'
import { type AppEnv } from './env'
import { resolveEquityOptionContract } from './option-contract'
import { assertPortfolioActionAllowed } from './portfolio-risk'
import { resolveAccountNumber, tastyRequest } from './tastytrade'

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

function orderResponse(payload: unknown): { id?: string } {
  const body = record(payload)
  const data = record(body.data ?? body)
  const errors = rows(data.errors ?? body.errors)
  if (errors.length) {
    const message = errors.map((error) => String(error.message ?? error.code ?? 'Order rejected')).join('; ')
    throw new Error(`TastytradeOrderRejected:${message.slice(0, 160)}`)
  }
  const order = record(data.order ?? body.order ?? data)
  const id = order.id === undefined || order.id === null ? undefined : String(order.id)
  return { id: id && /^\d{1,40}$/.test(id) ? id : undefined }
}

export class BrokerageSubmissionUnknownError extends Error {
  constructor() {
    super('Tastytrade may have received this order, but Spice could not verify the result. Reconciliation is required before another trade.')
    this.name = 'BrokerageSubmissionUnknownError'
  }
}

export async function executeBrokerageAction(env: AppEnv, untrustedAction: unknown): Promise<{ detail: string; orderId?: string }> {
  const action = BrokerageActionSchema.parse(untrustedAction)
  if (action.kind === 'add_watchlist_symbol' || action.kind === 'remove_watchlist_symbol') {
    const path = `/watchlists/${encodeURIComponent(action.watchlistName)}`
    const fetched = await tastyRequest(env, path)
    const body = typeof fetched === 'object' && fetched !== null ? fetched as Record<string, unknown> : {}
    const data = typeof body.data === 'object' && body.data !== null ? body.data as Record<string, unknown> : body
    const entries = rows(data['watchlist-entries'])
    const hasSymbol = entries.some((entry) => String(entry.symbol ?? '').toUpperCase() === action.symbol)
    const nextEntries = action.kind === 'add_watchlist_symbol'
      ? hasSymbol ? entries : [...entries, { symbol: action.symbol, 'instrument-type': 'Equity' }]
      : entries.filter((entry) => String(entry.symbol ?? '').toUpperCase() !== action.symbol)
    const payload = {
      name: typeof data.name === 'string' ? data.name : action.watchlistName,
      'watchlist-entries': nextEntries,
      'group-name': typeof data['group-name'] === 'string' ? data['group-name'] : 'default',
      'order-index': typeof data['order-index'] === 'number' ? data['order-index'] : 9999,
    }
    await tastyRequest(env, path, { method: 'PUT', body: JSON.stringify(payload) })
    return { detail: `${action.symbol} ${action.kind === 'add_watchlist_symbol' ? 'added to' : 'removed from'} ${action.watchlistName}` }
  }
  const account = await resolveAccountNumber(env)
  if (action.kind === 'cancel_order') {
    await tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders/${action.orderId}`, { method: 'DELETE' })
    return { detail: `Order #${action.orderId} cancelled`, orderId: action.orderId }
  }
  const optionContract = action.kind === 'place_option_order' ? await resolveEquityOptionContract(env, action) : undefined
  await assertPortfolioActionAllowed(env, action, { accountNumber: account, optionContract })
  const symbol = action.kind === 'place_option_order' ? optionContract!.symbol : action.symbol
  const payload = {
    'order-type': 'Limit', 'time-in-force': 'Day', price: action.limitPrice.toFixed(2), 'price-effect': action.priceEffect,
    legs: [{ action: action.action, quantity: action.quantity, symbol, 'instrument-type': action.kind === 'place_option_order' ? 'Equity Option' : 'Equity' }],
  }
  const dryRun = await tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders/dry-run`, { method: 'POST', body: JSON.stringify(payload) })
  orderResponse(dryRun)
  let placed: unknown
  try {
    placed = await tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders`, { method: 'POST', body: JSON.stringify(payload) })
  } catch (error) {
    if (error instanceof Error && error.name === 'TastytradeApiError') throw error
    throw new BrokerageSubmissionUnknownError()
  }
  const orderId = orderResponse(placed).id
  if (!orderId) throw new BrokerageSubmissionUnknownError()
  return { detail: `Order #${orderId} accepted by tastytrade`, orderId }
}
