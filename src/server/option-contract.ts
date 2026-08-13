import { type BrokerageAction } from './agent-contracts'
import { type AppEnv } from './env'
import { tastyRequest } from './tastytrade'

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? value as JsonRecord : {}
}

function rows(value: unknown): JsonRecord[] {
  return Array.isArray(value) ? value.map(record) : []
}

export interface EquityOptionContract {
  sharesPerContract: number
  symbol: string
}

export async function resolveEquityOptionContract(
  env: AppEnv,
  action: Extract<BrokerageAction, { kind: 'place_option_order' }>,
): Promise<EquityOptionContract> {
  const payload = await tastyRequest(env, `/option-chains/${encodeURIComponent(action.underlying)}/nested`)
  const body = record(payload)
  const data = record(body.data)
  const matches = new Map<string, EquityOptionContract>()
  for (const chain of rows(data.items)) {
    const underlying = typeof chain['underlying-symbol'] === 'string' ? chain['underlying-symbol'].trim().toUpperCase() : ''
    const root = typeof chain['root-symbol'] === 'string' ? chain['root-symbol'].trim().toUpperCase() : ''
    const deliverables = chain.deliverables
    if (chain['option-chain-type'] !== 'Standard'
      || underlying !== action.underlying
      || root !== action.underlying
      || (deliverables !== undefined && deliverables !== null
        && (!Array.isArray(deliverables) || deliverables.length > 0))) continue
    const sharesPerContract = Number(chain['shares-per-contract'])
    if (!Number.isFinite(sharesPerContract) || sharesPerContract <= 0) continue
    for (const expiration of rows(chain.expirations)) {
      if (expiration['expiration-date'] !== action.expiry) continue
      for (const strike of rows(expiration.strikes)) {
        if (Number(strike['strike-price']) !== action.strike) continue
        const symbol = action.optionType === 'C' ? strike.call : strike.put
        if (typeof symbol === 'string' && symbol) {
          matches.set(`${symbol}:${sharesPerContract}`, { symbol, sharesPerContract })
        }
      }
    }
  }
  if (matches.size === 1) return [...matches.values()][0]!
  if (matches.size > 1) throw new Error('Requested option contract is ambiguous')
  console.warn('OptionContractUnavailable', JSON.stringify({
    requested: { underlying: action.underlying, expiry: action.expiry, strike: action.strike, optionType: action.optionType },
    chains: rows(data.items).map((chain) => {
      const expirations = rows(chain.expirations)
      const requestedExpiration = expirations.find((expiration) => expiration['expiration-date'] === action.expiry)
      const deliverables = chain.deliverables
      return {
        underlying: chain['underlying-symbol'],
        root: chain['root-symbol'],
        chainType: chain['option-chain-type'],
        sharesPerContract: chain['shares-per-contract'],
        deliverables: Array.isArray(deliverables)
          ? `array:${deliverables.length}`
          : deliverables && typeof deliverables === 'object'
            ? `object:${Object.keys(deliverables).sort().join(',')}`
            : String(deliverables),
        expirationCount: expirations.length,
        requestedExpiryExists: Boolean(requestedExpiration),
        requestedStrikeExists: rows(requestedExpiration?.strikes)
          .some((strike) => Number(strike['strike-price']) === action.strike),
      }
    }),
  }))
  throw new Error('Requested option contract is not available')
}
