import { Type } from '@earendil-works/pi-ai'
import { type AgentTool } from '@earendil-works/pi-agent-core'

import { EQUITY_SYMBOL_PATTERN, EquitySymbolSchema } from '../domain/instrument'
import { MAX_WATCHLIST_SYMBOLS } from '../domain/watchlist'
import { DirectAccountActionSchema } from './agent-contracts'
import { type AppEnv } from './env'
import { brokerApi } from './tastytrade'
import { textResult } from './agent-tool-result'
import { watchlistWriter } from './watchlist-actions'
import { internalWatchlistWriter } from './internal-watchlist'

const DirectAccountActionParameters = Type.Union([
  Type.Object({
    kind: Type.Literal('cancel_order'),
    orderId: Type.String({ pattern: '^\\d{1,40}$' }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('add_watchlist_symbols'),
    symbols: Type.Array(Type.String({ pattern: EQUITY_SYMBOL_PATTERN }), { maxItems: MAX_WATCHLIST_SYMBOLS, minItems: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    kind: Type.Literal('remove_watchlist_symbols'),
    symbols: Type.Array(Type.String({ pattern: EQUITY_SYMBOL_PATTERN }), { maxItems: MAX_WATCHLIST_SYMBOLS, minItems: 1 }),
  }, { additionalProperties: false }),
])

const RememberTradeSymbolsParameters = Type.Object({
  symbols: Type.Array(Type.String({ pattern: EQUITY_SYMBOL_PATTERN }), { maxItems: MAX_WATCHLIST_SYMBOLS, minItems: 1 }),
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

export class BrokerageCancellationUnknownError extends Error {
  constructor() {
    super('Tastytrade may have received this cancellation, but Spice could not verify the result. Refresh working orders before taking any further action.')
    this.name = 'BrokerageCancellationUnknownError'
  }
}

export function createDirectAccountActionTool(
  env: AppEnv,
  currentUserMessage: string,
): AgentTool<
  typeof DirectAccountActionParameters,
  { detail: string } | { orderId: string; status: 'cancelled' }
> {
  let attempted = false
  return {
    description: 'Cancel an order or add/remove private-watchlist symbols; executes immediately.',
    execute: async (_toolCallId, params) => {
      const parsed = DirectAccountActionSchema.parse(params)
      const authorized = parsed.kind === 'cancel_order'
        ? authorizesCancel(currentUserMessage, parsed.orderId)
        : authorizesWatchlistChange(
            currentUserMessage,
            parsed.kind === 'add_watchlist_symbols' ? 'add' : 'remove',
            parsed.symbols,
          )
      if (!authorized) throw new Error('DirectActionIntentMismatch')
      // A provider timeout after DELETE is ambiguous. One tool instance represents one
      // user turn, so the model cannot turn any uncertain mutation into an automatic retry.
      if (attempted) throw new Error('DirectActionAlreadyAttempted')
      attempted = true
      if (parsed.kind === 'cancel_order') {
        return brokerApi().withBrokerMutationLease(env, async (lease) => {
          const account = await brokerApi().resolveAccountNumber(env)
          await lease.renew()
          try {
            await brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(account)}/orders/${parsed.orderId}`, { method: 'DELETE' })
          } catch (error) {
            // A provider 4xx proves the cancellation was rejected. A network loss,
            // timeout, 5xx, or unreadable success response after DELETE means the
            // broker may have received it, so it must never become an automatic retry.
            if (error instanceof Error && error.name === 'TastytradeApiError') throw error
            throw new BrokerageCancellationUnknownError()
          }
          return textResult({ orderId: parsed.orderId, status: 'cancelled' as const })
        })
      }
      return textResult(await watchlistWriter().executeWatchlistAction(env, parsed))
    },
    executionMode: 'sequential',
    label: 'Applying account action',
    name: 'apply_direct_account_action',
    parameters: DirectAccountActionParameters,
  }
}

export function createRememberTradeSymbolsTool(
  env: AppEnv,
): AgentTool<typeof RememberTradeSymbolsParameters, { remembered: string[] }> {
  return {
    description: 'Add trade-thesis tickers to the private watchlist.',
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
