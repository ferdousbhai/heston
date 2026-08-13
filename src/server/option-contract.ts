import { type BrokerageAction } from './agent-contracts'
import { type AppEnv } from './env'
import { tastyRequest } from './tastytrade'

type JsonRecord = Record<string, unknown>
type OptionAction = Extract<BrokerageAction, { kind: 'place_option_order' }>

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? value as JsonRecord : {}
}

function chainRows(payload: unknown): JsonRecord[] {
  const body = record(payload)
  const data = record(body.data)
  if (!Array.isArray(data.items)) throw new Error('Requested option contract is not available. The option chain response was incomplete.')
  return data.items.map(record)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function number(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function unavailable(detail: string): Error {
  return new Error(`Requested option contract is not available. ${detail}`)
}

function shortList(values: string[]): string {
  const unique = [...new Set(values)].sort()
  return unique.length ? unique.slice(0, 8).join(', ') : 'none'
}

function nearestStrikes(rows: JsonRecord[], requestedStrike: number): string {
  const strikes = [...new Set(rows.flatMap((row) => {
    const strike = number(row['strike-price'])
    return strike === undefined ? [] : [strike]
  }))]
  return strikes
    .sort((left, right) => Math.abs(left - requestedStrike) - Math.abs(right - requestedStrike))
    .slice(0, 8)
    .sort((left, right) => left - right)
    .join(', ') || 'none'
}

export interface EquityOptionContract {
  sharesPerContract: number
  symbol: string
}

/** Resolve one exact, standard, active contract from tastytrade's detailed option instruments. */
export function equityOptionContractFromChain(payload: unknown, action: OptionAction): EquityOptionContract {
  const rows = chainRows(payload)
  const standardRows = rows.filter((row) => (
    text(row['instrument-type']) === 'Equity Option'
    && text(row['underlying-symbol']).toUpperCase() === action.underlying
    && text(row['root-symbol']).toUpperCase() === action.underlying
    && text(row['option-chain-type']) === 'Standard'
  ))
  const expirationRows = standardRows.filter((row) => text(row['expiration-date']) === action.expiry)
  if (!expirationRows.length) {
    throw unavailable(`Available standard expirations: ${shortList(standardRows.map((row) => text(row['expiration-date'])).filter(Boolean))}.`)
  }
  const sideRows = expirationRows.filter((row) => text(row['option-type']) === action.optionType)
  const strikeRows = sideRows.filter((row) => number(row['strike-price']) === action.strike)
  if (!strikeRows.length) {
    throw unavailable(`Nearest ${action.optionType === 'C' ? 'call' : 'put'} strikes: ${nearestStrikes(sideRows, action.strike)}.`)
  }
  const isOpening = action.action.endsWith('to Open')
  const candidates: EquityOptionContract[] = []
  for (const row of strikeRows) {
    const symbol = text(row.symbol)
    const sharesPerContract = number(row['shares-per-contract'])
    if (row.active !== true
      || (isOpening && row['is-closing-only'] !== false)
      || !symbol
      || sharesPerContract === undefined
      || !Number.isSafeInteger(sharesPerContract)
      || sharesPerContract <= 0) continue
    candidates.push({ symbol, sharesPerContract })
  }
  if (candidates.length === 1) return candidates[0]!
  if (candidates.length > 1) throw new Error('Requested option contract is ambiguous')
  if (isOpening && strikeRows.some((row) => row.active === true && row['is-closing-only'] !== false)) {
    throw unavailable('The matching contract is closing-only or its opening status could not be verified.')
  }
  throw unavailable('The matching contract is inactive or its multiplier could not be verified.')
}

export async function resolveEquityOptionContract(
  env: AppEnv,
  action: OptionAction,
): Promise<EquityOptionContract> {
  const payload = await tastyRequest(env, `/option-chains/${encodeURIComponent(action.underlying)}`)
  return equityOptionContractFromChain(payload, action)
}
