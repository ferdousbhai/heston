import { type OrderPlacement } from './agent-contracts'
import { type AppEnv } from './env'
import {
  JsonArraySchema,
  JsonObjectSchema,
  NumericSchema,
  TextSchema,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { brokerApi } from './tastytrade'

type OptionAction = Extract<OrderPlacement, { kind: 'place_option_order' }>

function record(value: JsonValue): JsonObject {
  return JsonObjectSchema.safeParse(value).data ?? {}
}

function chainRows(payload: JsonValue): JsonObject[] {
  const data = record(record(payload).data)
  const items = JsonArraySchema.safeParse(data.items).data
  if (!items) throw new Error('Requested option contract is not available. The option chain response was incomplete.')
  return items.map(record)
}

function text(value: JsonValue): string {
  return TextSchema.safeParse(value).data ?? ''
}

function number(value: JsonValue): number | undefined {
  return NumericSchema.safeParse(value).data
}

function unavailable(detail: string): Error {
  return new Error(`Requested option contract is not available. ${detail}`)
}

function shortList(values: string[]): string {
  const unique = [...new Set(values)].sort()
  return unique.length ? unique.slice(0, 8).join(', ') : 'none'
}

function nearestStrikes(rows: JsonObject[], requestedStrike: number): string {
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
  streamerSymbol?: string
}

export interface EquityOptionTuple {
  expiry: string
  optionType: 'C' | 'P'
  strike: number
  underlying: string
}

type ResolutionOptions = {
  opening?: boolean
  requireStreamerSymbol?: boolean
}

export type ResolvedEquityOptionTuple = EquityOptionTuple & EquityOptionContract

/** Resolve one exact, standard, active contract without assuming its root equals the underlying. */
export function equityOptionContractFromChainTuple(
  payload: JsonValue,
  tuple: EquityOptionTuple,
  options: ResolutionOptions = {},
): EquityOptionContract {
  const rows = chainRows(payload)
  const standardRows = rows.filter((row) => (
    text(row['instrument-type']) === 'Equity Option'
    && text(row['underlying-symbol']).toUpperCase() === tuple.underlying
    && text(row['option-chain-type']) === 'Standard'
  ))
  const expirationRows = standardRows.filter((row) => text(row['expiration-date']) === tuple.expiry)
  if (!expirationRows.length) {
    throw unavailable(`Available standard expirations: ${shortList(standardRows.map((row) => text(row['expiration-date'])).filter(Boolean))}.`)
  }
  const sideRows = expirationRows.filter((row) => text(row['option-type']) === tuple.optionType)
  const strikeRows = sideRows.filter((row) => number(row['strike-price']) === tuple.strike)
  if (!strikeRows.length) {
    throw unavailable(`Nearest ${tuple.optionType === 'C' ? 'call' : 'put'} strikes: ${nearestStrikes(sideRows, tuple.strike)}.`)
  }
  const candidates: EquityOptionContract[] = []
  for (const row of strikeRows) {
    const symbol = text(row.symbol)
    const streamerSymbol = text(row['streamer-symbol'])
    const sharesPerContract = number(row['shares-per-contract'])
    if (row.active !== true
      || (options.opening && row['is-closing-only'] !== false)
      || !symbol
      || sharesPerContract === undefined
      || !Number.isSafeInteger(sharesPerContract)
      || sharesPerContract <= 0) continue
    const candidate: EquityOptionContract = { symbol, sharesPerContract }
    if (streamerSymbol) candidate.streamerSymbol = streamerSymbol
    candidates.push(candidate)
  }
  if (candidates.length > 1) throw new Error('Requested option contract is ambiguous')
  if (candidates.length === 1) {
    const candidate = candidates[0]!
    if (options.requireStreamerSymbol && !candidate.streamerSymbol) {
      throw unavailable('The matching contract has no verified market-data streamer symbol.')
    }
    return candidate
  }
  if (options.opening && strikeRows.some((row) => row.active === true && row['is-closing-only'] !== false)) {
    throw unavailable('The matching contract is closing-only or its opening status could not be verified.')
  }
  throw unavailable('The matching contract is inactive or its multiplier could not be verified.')
}

/** Resolve one exact, standard, active contract for execution. */
export function equityOptionContractFromChain(payload: JsonValue, action: OptionAction): EquityOptionContract {
  return equityOptionContractFromChainTuple(payload, action, { opening: action.action.endsWith('to Open') })
}

export async function resolveEquityOptionContract(
  env: AppEnv,
  action: OptionAction,
): Promise<EquityOptionContract> {
  const payload = await brokerApi().tastyRequest(env, `/option-chains/${encodeURIComponent(action.underlying)}`)
  return equityOptionContractFromChain(payload, action)
}

/** Fetch each underlying once, resolve its tuples immediately, then release the large chain payload. */
export async function resolveEquityOptionTuples(
  env: AppEnv,
  tuples: readonly EquityOptionTuple[],
  options: ResolutionOptions = {},
): Promise<ResolvedEquityOptionTuple[]> {
  const groups = new Map<string, Array<{ index: number; tuple: EquityOptionTuple }>>()
  tuples.forEach((tuple, index) => {
    const group = groups.get(tuple.underlying) ?? []
    group.push({ index, tuple })
    groups.set(tuple.underlying, group)
  })
  const resolved: Array<ResolvedEquityOptionTuple | undefined> = Array.from({ length: tuples.length })
  for (const [underlying, group] of groups) {
    const payload = await brokerApi().tastyRequest(env, `/option-chains/${encodeURIComponent(underlying)}`)
    for (const { index, tuple } of group) {
      resolved[index] = { ...tuple, ...equityOptionContractFromChainTuple(payload, tuple, options) }
    }
  }
  return resolved.map((contract) => {
    if (!contract) throw new Error('Requested option contract is not available. Resolution was incomplete.')
    return contract
  })
}
