import { Type } from '@earendil-works/pi-ai'
import { type AgentTool } from '@earendil-works/pi-agent-core'

import { EQUITY_SYMBOL_PATTERN, EquitySymbolSchema } from '../domain/instrument'
import { DirectAccountActionSchema } from './agent-contracts'
import { type AppEnv } from './env'
import { brokerApi } from './tastytrade'
import { textResult } from './agent-tool-result'
import { watchlistWriter } from './watchlist-actions'
import { internalWatchlistWriter } from './internal-watchlist'

const CancelOrderParameters = Type.Object({
  orderId: Type.String({ description: 'Exact tastytrade working-order ID.', pattern: '^\\d{1,40}$' }),
}, { additionalProperties: false })

const WatchlistManagementParameters = Type.Union([
  Type.Object({
    action: Type.Literal('add'),
    symbols: Type.Array(Type.String({ pattern: EQUITY_SYMBOL_PATTERN }), { maxItems: 50, minItems: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('remove'),
    symbols: Type.Array(Type.String({ pattern: EQUITY_SYMBOL_PATTERN }), { maxItems: 50, minItems: 1 }),
  }, { additionalProperties: false }),
])

const RememberTradeSymbolsParameters = Type.Object({
  symbols: Type.Array(Type.String({ pattern: EQUITY_SYMBOL_PATTERN }), { maxItems: 10, minItems: 1 }),
}, { additionalProperties: false })

function commandText(message: string): string {
  let command = message.normalize('NFKC').trim()
  for (;;) {
    const next = command.replace(
      /^(?:dan\s*[:,]\s*|please\s+|kindly\s+|(?:can|could|would|will)\s+you\s+|i(?:'d| would)\s+like\s+you\s+to\s+|i\s+want\s+you\s+to\s+)/i,
      '',
    )
    if (next === command) return command
    command = next.trimStart()
  }
}

function requestedSymbols(value: string): string[] | undefined {
  const fragment = value.trim().replace(/^(?:stocks?|tickers?|symbols?)\s+/i, '')
  const parts = fragment.replace(/\s+(?:and|&)\s+/gi, ',').split(',').map((part) => part.trim())
  if (!parts.length) return undefined
  const symbols = parts.map((part) => EquitySymbolSchema.safeParse(part).data)
  return symbols.every((symbol): symbol is string => Boolean(symbol)) ? symbols : undefined
}

function authorizesCancel(message: string, orderId: string): boolean {
  const match = commandText(message).match(
    /^cancel(?:\s+(?:the|my))?(?:\s+(?:working|live))?(?:\s+order)?\s+#?(\d{1,40})(?:\s+please)?[.!?]*$/i,
  )
  return match?.[1] === orderId
}

function authorizesWatchlistChange(
  message: string,
  action: 'add' | 'remove',
  symbols: readonly string[],
): boolean {
  const command = commandText(message)
  const preposition = action === 'add' ? 'to' : 'from'
  const match = command.match(new RegExp(
    `^${action}\\s+(.+?)\\s+${preposition}\\s+(?:(?:my|the|private|spice)\\s+)?watchlist(?:\\s+please)?[.!?]*$`,
    'i',
  ))
  if (!match?.[1]) return false
  const authorizedSymbols = requestedSymbols(match[1])
  const normalizedSymbols = symbols.map((symbol) => symbol.toUpperCase())
  return Boolean(authorizedSymbols
    && new Set(authorizedSymbols).size === authorizedSymbols.length
    && new Set(normalizedSymbols).size === normalizedSymbols.length
    && authorizedSymbols.length === normalizedSymbols.length
    && authorizedSymbols.every((symbol) => normalizedSymbols.includes(symbol)))
}

export function createCancelOrderTool(
  env: AppEnv,
  currentUserMessage: string,
): AgentTool<typeof CancelOrderParameters, { orderId: string; status: 'cancelled' }> {
  let attempted = false
  return {
    description: 'Cancel one exact working tastytrade order immediately. Use only when the user explicitly asks to cancel that order in the current message. This does not require a confirmation step.',
    execute: async (_toolCallId, params) => {
      if (!authorizesCancel(currentUserMessage, params.orderId)) throw new Error('DirectActionIntentMismatch')
      const parsed = DirectAccountActionSchema.parse({ kind: 'cancel_order', orderId: params.orderId })
      if (parsed.kind !== 'cancel_order') throw new Error('CancelOrder:invalid-action')
      // A provider timeout after DELETE is ambiguous. One tool instance represents one
      // user turn, so the model cannot turn an uncertain outcome into an automatic retry.
      if (attempted) throw new Error('DirectActionAlreadyAttempted')
      attempted = true
      return brokerApi().withBrokerMutationLease(env, async (lease) => {
        const account = await brokerApi().resolveAccountNumber(env)
        await lease.renew()
        await brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders/${parsed.orderId}`, { method: 'DELETE' })
        return textResult({ orderId: parsed.orderId, status: 'cancelled' as const })
      })
    },
    executionMode: 'sequential',
    label: 'Cancelling order',
    name: 'cancel_order',
    parameters: CancelOrderParameters,
  }
}

export function createWatchlistManagementTool(
  env: AppEnv,
  currentUserMessage: string,
): AgentTool<typeof WatchlistManagementParameters, { detail: string }> {
  let attempted = false
  return {
    description: "Add or remove equity symbols in Spice's single internal private watchlist immediately. Use only when the user explicitly requests the exact change in the current message. This does not require a confirmation step.",
    execute: async (_toolCallId, params) => {
      if (!authorizesWatchlistChange(
        currentUserMessage,
        params.action,
        params.symbols,
      )) throw new Error('DirectActionIntentMismatch')
      const action = DirectAccountActionSchema.parse({
        kind: params.action === 'add' ? 'add_watchlist_symbols' : 'remove_watchlist_symbols',
        symbols: params.symbols,
      })
      if (action.kind !== 'add_watchlist_symbols' && action.kind !== 'remove_watchlist_symbols'
      ) throw new Error('WatchlistMutation:invalid-action')
      // One direct mutation attempt per user turn keeps model tool loops bounded.
      if (attempted) throw new Error('DirectActionAlreadyAttempted')
      attempted = true
      return textResult(await watchlistWriter().executeWatchlistAction(env, action))
    },
    executionMode: 'sequential',
    label: 'Updating watchlist',
    name: 'manage_watchlist',
    parameters: WatchlistManagementParameters,
  }
}

export function createRememberTradeSymbolsTool(
  env: AppEnv,
): AgentTool<typeof RememberTradeSymbolsParameters, { remembered: string[] }> {
  return {
    description: "Remember symbols in Spice's internal watchlist when this conversation substantively discusses a trade, thesis, or potential play for a symbol that may not already be watched. This is idempotent and does not place a trade. Do not use it for incidental ticker mentions.",
    execute: async (_toolCallId, params) => {
      const remembered = await internalWatchlistWriter().ensureSymbols(env, params.symbols, 'agent-discussion')
      return textResult({ remembered })
    },
    executionMode: 'sequential',
    label: 'Remembering symbols',
    name: 'remember_trade_symbols',
    parameters: RememberTradeSymbolsParameters,
  }
}
