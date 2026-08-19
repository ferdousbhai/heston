import { Type } from '@earendil-works/pi-ai'
import { type AgentTool } from '@earendil-works/pi-agent-core'

import { DirectAccountActionSchema } from './agent-contracts'
import { type AppEnv } from './env'
import { brokerApi } from './tastytrade'
import { textResult } from './agent-tool-result'
import { watchlistWriter } from './watchlist-actions'

export const CancelOrderParameters = Type.Object({
  orderId: Type.String({ description: 'Exact tastytrade working-order ID.', pattern: '^\\d{1,40}$' }),
}, { additionalProperties: false })

export const WatchlistManagementParameters = Type.Union([
  Type.Object({
    action: Type.Literal('add'),
    symbols: Type.Array(Type.String({ pattern: '^[A-Z.]{1,8}$' }), { maxItems: 50, minItems: 1 }),
    watchlistName: Type.String({ maxLength: 64, minLength: 1, pattern: '^(?=.*\\S)[^/]+$' }),
  }, { additionalProperties: false }),
  Type.Object({
    action: Type.Literal('remove'),
    symbols: Type.Array(Type.String({ pattern: '^[A-Z.]{1,8}$' }), { maxItems: 50, minItems: 1 }),
    watchlistName: Type.String({ maxLength: 64, minLength: 1, pattern: '^(?=.*\\S)[^/]+$' }),
  }, { additionalProperties: false }),
])

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

function cleanName(value: string): string {
  return value
    .trim()
    .replace(/\s+please[.!?]*$/i, '')
    .replace(/[.!?]+$/, '')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US')
}

function requestedSymbols(value: string): string[] | undefined {
  const fragment = value.trim().replace(/^(?:stocks?|tickers?|symbols?)\s+/i, '')
  const parts = fragment.replace(/\s+(?:and|&)\s+/gi, ',').split(',').map((part) => part.trim())
  if (!parts.length || parts.some((part) => !/^[A-Z.]{1,8}$/i.test(part))) return undefined
  return parts.map((part) => part.toUpperCase())
}

export function authorizesCancel(message: string, orderId: string): boolean {
  const match = commandText(message).match(
    /^cancel(?:\s+(?:the|my))?(?:\s+(?:working|live))?(?:\s+order)?\s+#?(\d{1,40})(?:\s+please)?[.!?]*$/i,
  )
  return match?.[1] === orderId
}

export function authorizesWatchlistChange(
  message: string,
  action: 'add' | 'remove',
  watchlistName: string,
  symbols: readonly string[],
): boolean {
  const command = commandText(message)
  const preposition = action === 'add' ? 'to' : 'from'
  const match = command.match(new RegExp(`^${action}\\s+(.+?)\\s+${preposition}\\s+(?:(?:my|the|private)\\s+)?(.+?)\\s+watchlist(?:\\s+please)?[.!?]*$`, 'i'))
    ?? command.match(new RegExp(`^${action}\\s+(.+?)\\s+${preposition}\\s+(?:(?:my|the|private)\\s+)?watchlist\\s+(.+?)(?:\\s+please)?[.!?]*$`, 'i'))
  if (!match?.[1] || !match[2] || cleanName(match[2]) !== cleanName(watchlistName)) return false
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
  return {
    description: 'Cancel one exact working tastytrade order immediately. Use only when the user explicitly asks to cancel that order in the current message. This does not require a confirmation step.',
    execute: async (_toolCallId, params) => {
      if (!authorizesCancel(currentUserMessage, params.orderId)) throw new Error('DirectActionIntentMismatch')
      const parsed = DirectAccountActionSchema.parse({ kind: 'cancel_order', orderId: params.orderId })
      if (parsed.kind !== 'cancel_order') throw new Error('CancelOrder:invalid-action')
      const account = await brokerApi().resolveAccountNumber(env)
      await brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders/${parsed.orderId}`, { method: 'DELETE' })
      return textResult({ orderId: parsed.orderId, status: 'cancelled' as const })
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
  return {
    description: 'Add or remove equity symbols in an existing private tastytrade watchlist immediately. Use only when the user explicitly requests the exact change in the current message. This does not require a confirmation step.',
    execute: async (_toolCallId, params) => {
      if (!authorizesWatchlistChange(
        currentUserMessage,
        params.action,
        params.watchlistName,
        params.symbols,
      )) throw new Error('DirectActionIntentMismatch')
      const action = DirectAccountActionSchema.parse({
        kind: params.action === 'add' ? 'add_watchlist_symbols' : 'remove_watchlist_symbols',
        symbols: params.symbols,
        watchlistName: params.watchlistName,
      })
      if (action.kind !== 'add_watchlist_symbols' && action.kind !== 'remove_watchlist_symbols'
      ) throw new Error('WatchlistMutation:invalid-action')
      return textResult(await watchlistWriter().executeWatchlistAction(env, action))
    },
    executionMode: 'sequential',
    label: 'Updating watchlist',
    name: 'manage_watchlist',
    parameters: WatchlistManagementParameters,
  }
}
