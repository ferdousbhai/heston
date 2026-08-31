import { type OrderPlacement } from './agent-contracts'
import { type AppEnv } from './env'
import { type EquityOptionTuple } from '../domain/equity-option'
import {
  JsonArraySchema,
  jsonNumber,
  jsonObjectOrEmpty,
  jsonTextOrEmpty,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { brokerApi } from './tastytrade'
import { OwnerVisibleError } from './owner-visible-error'

type OptionAction = Extract<OrderPlacement, { kind: 'place_option_order' }>
// Error details show enough alternatives to correct a tuple without echoing a full option chain.
const MAX_RESOLUTION_SUGGESTIONS = 8

export class OptionContractUnavailableError extends OwnerVisibleError {
  constructor(detail: string) {
    super('option-contract', `Requested option contract is not available. ${detail}`)
    this.name = 'OptionContractUnavailableError'
  }
}

function chainRows(payload: JsonValue): JsonObject[] {
  const data = jsonObjectOrEmpty(jsonObjectOrEmpty(payload).data)
  const items = JsonArraySchema.safeParse(data.items).data
  if (!items) throw new OptionContractUnavailableError('The option chain response was incomplete.')
  return items.map(jsonObjectOrEmpty)
}

function unavailable(detail: string): Error {
  return new OptionContractUnavailableError(detail)
}

function shortList(values: string[]): string {
  const unique = [...new Set(values)].sort()
  return unique.length ? unique.slice(0, MAX_RESOLUTION_SUGGESTIONS).join(', ') : 'none'
}

function nearestStrikes(rows: JsonObject[], requestedStrike: number): string {
  const strikes = [...new Set(rows.flatMap((row) => {
    const strike = jsonNumber(row['strike-price'])
    return strike === undefined ? [] : [strike]
  }))]
  return strikes
    .sort((left, right) => Math.abs(left - requestedStrike) - Math.abs(right - requestedStrike))
    .slice(0, MAX_RESOLUTION_SUGGESTIONS)
    .sort((left, right) => left - right)
    .join(', ') || 'none'
}

export interface EquityOptionContract {
  sharesPerContract: number
  symbol: string
  streamerSymbol?: string
}

type ResolutionOptions = {
  opening?: boolean
  requireStreamerSymbol?: boolean
}

export type ResolvedEquityOptionTuple = EquityOptionTuple & EquityOptionContract

export type { EquityOptionTuple }

/** Resolve one exact, standard, active contract without assuming its root equals the underlying. */
export function equityOptionContractFromChainTuple(
  payload: JsonValue,
  tuple: EquityOptionTuple,
  options: ResolutionOptions = {},
): EquityOptionContract {
  const rows = chainRows(payload)
  const standardRows = rows.filter((row) => (
    jsonTextOrEmpty(row['instrument-type']) === 'Equity Option'
    && jsonTextOrEmpty(row['underlying-symbol']).toUpperCase() === tuple.underlying
    && jsonTextOrEmpty(row['option-chain-type']) === 'Standard'
  ))
  const expirationRows = standardRows.filter((row) => jsonTextOrEmpty(row['expiration-date']) === tuple.expiry)
  if (!expirationRows.length) {
    throw unavailable(`Available standard expirations: ${shortList(standardRows.map((row) => jsonTextOrEmpty(row['expiration-date'])).filter(Boolean))}.`)
  }
  const sideRows = expirationRows.filter((row) => jsonTextOrEmpty(row['option-type']) === tuple.optionType)
  const strikeRows = sideRows.filter((row) => jsonNumber(row['strike-price']) === tuple.strike)
  if (!strikeRows.length) {
    throw unavailable(`Nearest ${tuple.optionType === 'C' ? 'call' : 'put'} strikes: ${nearestStrikes(sideRows, tuple.strike)}.`)
  }
  const candidates: EquityOptionContract[] = []
  for (const row of strikeRows) {
    const symbol = jsonTextOrEmpty(row.symbol)
    const streamerSymbol = jsonTextOrEmpty(row['streamer-symbol'])
    const sharesPerContract = jsonNumber(row['shares-per-contract'])
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
  // The groups partition every tuple index exactly once, and an unresolvable tuple throws,
  // so a returned array of the requested length has no unresolved slot.
  const resolved: ResolvedEquityOptionTuple[] = []
  for (const [underlying, group] of groups) {
    const payload = await brokerApi().tastyRequest(env, `/option-chains/${encodeURIComponent(underlying)}`)
    for (const { index, tuple } of group) {
      resolved[index] = { ...tuple, ...equityOptionContractFromChainTuple(payload, tuple, options) }
    }
  }
  if (resolved.length !== tuples.length) {
    throw new OptionContractUnavailableError('Resolution was incomplete.')
  }
  return resolved
}
