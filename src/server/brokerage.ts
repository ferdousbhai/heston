import { BrokerageActionSchema, type BrokerageAction } from './agent-contracts'
import { type AppEnv } from './env'
import { resolveAccountNumber, tastyRequest } from './tastytrade'

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
}

async function optionInstrumentSymbol(env: AppEnv, action: Extract<BrokerageAction, { kind: 'place_option_order' }>): Promise<string> {
  const payload = await tastyRequest(env, `/option-chains/${encodeURIComponent(action.underlying)}/nested`)
  const body = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {}
  const data = typeof body.data === 'object' && body.data !== null ? body.data as Record<string, unknown> : {}
  for (const chain of rows(data.items)) {
    for (const expiration of rows(chain.expirations)) {
      if (expiration['expiration-date'] !== action.expiry) continue
      for (const strike of rows(expiration.strikes)) {
        if (Number(strike['strike-price']) !== action.strike) continue
        const symbol = action.optionType === 'C' ? strike.call : strike.put
        if (typeof symbol === 'string' && symbol) return symbol
      }
    }
  }
  throw new Error('Requested option contract is not available')
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
  const symbol = action.kind === 'place_option_order' ? await optionInstrumentSymbol(env, action) : action.symbol
  const payload = {
    'order-type': 'Limit', 'time-in-force': 'Day', price: action.limitPrice.toFixed(2), 'price-effect': action.priceEffect,
    legs: [{ action: action.action, quantity: action.quantity, symbol, 'instrument-type': action.kind === 'place_option_order' ? 'Equity Option' : 'Equity' }],
  }
  await tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders/dry-run`, { method: 'POST', body: JSON.stringify(payload) })
  const placed = await tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders`, { method: 'POST', body: JSON.stringify(payload) })
  const body = typeof placed === 'object' && placed !== null ? placed as Record<string, unknown> : {}
  const data = typeof body.data === 'object' && body.data !== null ? body.data as Record<string, unknown> : body
  const order = typeof data.order === 'object' && data.order !== null ? data.order as Record<string, unknown> : data
  const orderId = String(order.id ?? '') || undefined
  return { detail: orderId ? `Order #${orderId} accepted by tastytrade` : 'Order accepted by tastytrade', orderId }
}
