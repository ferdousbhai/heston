import { type AppEnv } from './env'
import { resolveAccountNumber, tastyRequest } from './tastytrade'

type JsonRecord = Record<string, unknown>

export interface BrokerageContext {
  balances: { buyingPower?: number; cash?: number; netLiquidatingValue?: number }
  orders: Array<{ id: string; status: string; symbol: string; type: string }>
  positions: Array<{ quantity: number; symbol: string; underlying: string }>
  watchlists: Array<{ name: string; symbols: string[] }>
}

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? value as JsonRecord : {}
}

function items(value: unknown): JsonRecord[] {
  const body = record(value)
  const data = record(body.data)
  const candidate = Array.isArray(value) ? value : data.items ?? body.items
  return Array.isArray(candidate) ? candidate.map(record) : []
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function number(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function firstNumber(row: JsonRecord, names: string[]): number | undefined {
  return names.map((name) => number(row[name])).find((value) => value !== undefined)
}

export async function loadBrokerageContext(env: AppEnv): Promise<BrokerageContext> {
  const account = await resolveAccountNumber(env)
  const [positionResult, balanceResult, orderResult, watchlistResult] = await Promise.allSettled([
    tastyRequest(env, `/accounts/${encodeURIComponent(account)}/positions`),
    tastyRequest(env, `/accounts/${encodeURIComponent(account)}/balances`),
    tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders/live`),
    tastyRequest(env, '/watchlists'),
  ])
  const positions = positionResult.status === 'fulfilled' ? items(positionResult.value) : []
  const orders = orderResult.status === 'fulfilled' ? items(orderResult.value) : []
  const watchlists = watchlistResult.status === 'fulfilled' ? items(watchlistResult.value) : []
  const balancePayload = balanceResult.status === 'fulfilled' ? record(balanceResult.value) : {}
  const balances = record(balancePayload.data ?? balancePayload)
  return {
    balances: {
      netLiquidatingValue: firstNumber(balances, ['net-liquidating-value', 'net-liquidating-value-snapshot']),
      cash: firstNumber(balances, ['cash-balance', 'cash-available-to-withdraw']),
      buyingPower: firstNumber(balances, ['derivative-buying-power', 'equity-buying-power', 'buying-power']),
    },
    positions: positions.slice(0, 100).flatMap((row) => {
      const symbol = text(row.symbol)
      const underlying = text(row['underlying-symbol'], symbol).toUpperCase()
      const quantity = number(row.quantity)
      return symbol && underlying && quantity !== undefined && quantity !== 0
        ? [{ symbol, underlying, quantity }]
        : []
    }),
    orders: orders.slice(0, 100).map((row) => {
      const legs = Array.isArray(row.legs) ? row.legs.map(record) : []
      return {
        id: String(row.id ?? ''),
        status: text(row.status, 'Unknown'),
        type: text(row['order-type'], 'Order'),
        symbol: text(legs[0]?.symbol ?? row.symbol, 'Unknown'),
      }
    }).filter((order) => order.id),
    watchlists: watchlists.slice(0, 50).map((row) => ({
      name: text(row.name, 'Watchlist'),
      symbols: (Array.isArray(row['watchlist-entries']) ? row['watchlist-entries'].map(record) : [])
        .map((entry) => text(entry.symbol).toUpperCase()).filter(Boolean).slice(0, 100),
    })),
  }
}

function money(value: number | undefined): string {
  return value === undefined ? 'unavailable' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

export function answerBrokerageReadRequest(message: string, context: BrokerageContext): string | undefined {
  const wantsAccount = /\b(account|portfolio)\b/i.test(message)
  const sections: string[] = []
  if (wantsAccount || /\b(position|holding)s?\b/i.test(message)) {
    sections.push(context.positions.length
      ? `Positions: ${context.positions.map((position) => `${position.quantity} ${position.symbol}`).join(', ')}.`
      : 'Positions: none open.')
  }
  if (wantsAccount || /\b(balance|buying power|cash|net liq)\b/i.test(message)) {
    sections.push(`Net liq ${money(context.balances.netLiquidatingValue)} · buying power ${money(context.balances.buyingPower)} · cash ${money(context.balances.cash)}.`)
  }
  if (wantsAccount || /\b(open|working|live) orders?\b/i.test(message)) {
    sections.push(context.orders.length
      ? `Working orders: ${context.orders.map((order) => `#${order.id} ${order.symbol} (${order.status})`).join(', ')}.`
      : 'Working orders: none.')
  }
  if (/\bwatchlists?\b/i.test(message)) {
    sections.push(context.watchlists.length
      ? `Watchlists: ${context.watchlists.map((watchlist) => `${watchlist.name} [${watchlist.symbols.join(', ')}]`).join('; ')}.`
      : 'Watchlists: none.')
  }
  return sections.length ? sections.join('\n') : undefined
}
