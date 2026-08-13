import { type AppEnv } from './env'
import { resolveAccountNumber, tastyRequest } from './tastytrade'
import { accountBalanceRecord, isWorkingOrderRecord } from './tastytrade-payload'

type JsonRecord = Record<string, unknown>

export interface BrokerageContext {
  accountNumber: string
  balances: { buyingPower?: number; cash?: number; netLiquidatingValue?: number }
  availability: { balances: boolean; orders: boolean; positions: boolean; watchlists: boolean }
  orders: Array<{ id: string; status: string; symbol: string; type: string }>
  positions: Array<{
    direction: 'Long' | 'Short' | 'Unknown'
    instrumentType: string
    quantity: number
    symbol: string
    underlying: string
  }>
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
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function firstNumber(row: JsonRecord, names: string[]): number | undefined {
  return names.map((name) => number(row[name])).find((value) => value !== undefined)
}

export async function loadBrokerageContext(env: AppEnv): Promise<BrokerageContext> {
  const account = await resolveAccountNumber(env)
  const [positionResult, balanceResult, orderResult, complexOrderResult, watchlistResult] = await Promise.allSettled([
    tastyRequest(env, `/accounts/${encodeURIComponent(account)}/positions`),
    tastyRequest(env, `/accounts/${encodeURIComponent(account)}/balances`),
    tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders/live?per-page=200`),
    tastyRequest(env, `/accounts/${encodeURIComponent(account)}/complex-orders/live`),
    tastyRequest(env, '/watchlists'),
  ])
  const positions = positionResult.status === 'fulfilled' ? items(positionResult.value) : []
  const orders = [
    ...(orderResult.status === 'fulfilled' ? items(orderResult.value) : []),
    ...(complexOrderResult.status === 'fulfilled' ? items(complexOrderResult.value) : []),
  ].filter(isWorkingOrderRecord)
  const watchlists = watchlistResult.status === 'fulfilled' ? items(watchlistResult.value) : []
  const balances = balanceResult.status === 'fulfilled'
    ? accountBalanceRecord(balanceResult.value, account)
    : undefined
  const balanceRow = balances ?? {}
  const cashBalance = firstNumber(balanceRow, ['cash-balance'])
  const withdrawableCash = firstNumber(balanceRow, ['cash-available-to-withdraw'])
  return {
    accountNumber: account,
    availability: {
      balances: balances !== undefined,
      orders: orderResult.status === 'fulfilled' && complexOrderResult.status === 'fulfilled',
      positions: positionResult.status === 'fulfilled',
      watchlists: watchlistResult.status === 'fulfilled',
    },
    balances: {
      netLiquidatingValue: firstNumber(balanceRow, ['net-liquidating-value', 'net-liquidating-value-snapshot']),
      cash: cashBalance !== undefined && withdrawableCash !== undefined
        ? Math.min(cashBalance, withdrawableCash)
        : undefined,
      buyingPower: firstNumber(balanceRow, ['derivative-buying-power', 'equity-buying-power', 'buying-power']),
    },
    positions: positions.slice(0, 100).flatMap((row) => {
      const symbol = text(row.symbol)
      const underlying = text(row['underlying-symbol'], symbol).toUpperCase()
      const quantity = number(row.quantity)
      const rawDirection = text(row['quantity-direction'])
      const direction = rawDirection === 'Long' || rawDirection === 'Short' ? rawDirection : 'Unknown'
      return symbol && underlying && quantity !== undefined && quantity !== 0
        ? [{ symbol, underlying, quantity, direction, instrumentType: text(row['instrument-type'], 'Unknown') }]
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
  if (/\b(why|should|size|sizing|kelly|risk|hedge|trade|buy|sell|conviction|recommend)\b/i.test(message)) return undefined
  const wantsAccount = /\b(account|portfolio)\b/i.test(message)
  const sections: string[] = []
  if (wantsAccount || /\b(position|holding)s?\b/i.test(message)) {
    sections.push(!context.availability.positions
      ? 'Positions: unavailable.'
      : context.positions.length
      ? `Positions: ${context.positions.map((position) => `${position.direction === 'Short' ? '-' : ''}${position.quantity} ${position.symbol}`).join(', ')}.`
      : 'Positions: none open.')
  }
  if (wantsAccount || /\b(balance|buying power|cash|net liq)\b/i.test(message)) {
    sections.push(`Net liq ${money(context.balances.netLiquidatingValue)} · buying power ${money(context.balances.buyingPower)} · cash ${money(context.balances.cash)}.`)
  }
  if (wantsAccount || /\b(open|working|live) orders?\b/i.test(message)) {
    sections.push(!context.availability.orders
      ? 'Working orders: unavailable.'
      : context.orders.length
      ? `Working orders: ${context.orders.map((order) => `#${order.id} ${order.symbol} (${order.status})`).join(', ')}.`
      : 'Working orders: none.')
  }
  if (/\bwatchlists?\b/i.test(message)) {
    sections.push(!context.availability.watchlists
      ? 'Watchlists: unavailable.'
      : context.watchlists.length
      ? `Watchlists: ${context.watchlists.map((watchlist) => `${watchlist.name} [${watchlist.symbols.join(', ')}]`).join('; ')}.`
      : 'Watchlists: none.')
  }
  return sections.length ? sections.join('\n') : undefined
}
