import { type AgentTool } from '../domain/agent-tool'
import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'

import {
  EquityOptionTupleSchema,
  tupleKey,
  type EquityOptionTuple,
} from '../domain/equity-option'
import { isValidIsoDate } from '../domain/iso-date'
import { type AppEnv } from './env'
import {
  MAX_OPTION_GREEKS_CONTRACTS,
  OptionGreeksReadResultSchema,
  OptionStreamerSymbolSchema,
} from './market-feed-contracts'
import { textResult } from './agent-tool-result'
import { resolveEquityOptionTuples } from './option-contract'

export const ExactOptionGreeksReadParameters = Type.Object({
  contracts: Type.Array(EquityOptionTupleSchema, {
    maxItems: MAX_OPTION_GREEKS_CONTRACTS,
    minItems: 1,
  }),
}, { additionalProperties: false })

const ExactOptionGreeksReadValidator = Compile(ExactOptionGreeksReadParameters)

export type ExactOptionGreeksReadInput = Static<typeof ExactOptionGreeksReadParameters>

export type ExactOptionGreeksReadResult = {
  asOf: string
  contracts: Array<EquityOptionTuple & {
    delta: number
    eventAt: string
    gamma: number
    impliedVolatility: number
    impliedVolatilityUnit: 'decimal_ratio'
    optionPrice: number
    receivedAt: string
    rho: number
    sharesPerContract: number
    source: 'tastytrade-dxlink'
    streamerSymbol: string
    symbol: string
    theta: number
    vega: number
  }>
  impliedVolatilityUnit: 'decimal_ratio'
  source: 'tastytrade-dxlink'
}

/** Resolve exact broker instruments server-side, then ask the shared MarketFeed DO for live Greeks. */
export async function readExactOptionGreeks(
  env: AppEnv,
  input: ExactOptionGreeksReadInput,
): Promise<ExactOptionGreeksReadResult> {
  const parsed = ExactOptionGreeksReadValidator.Parse(input)
  if (parsed.contracts.some((contract) => !isValidIsoDate(contract.expiry))) {
    throw new Error('Option expiry is invalid.')
  }
  const contracts = [...new Map(parsed.contracts.map((contract) => [tupleKey(contract), contract])).values()]
  const resolved = (await resolveEquityOptionTuples(env, contracts, { requireStreamerSymbol: true })).map((instrument) => {
    return {
      contract: {
        expiry: instrument.expiry,
        optionType: instrument.optionType,
        strike: instrument.strike,
        underlying: instrument.underlying,
      },
      ...instrument,
      streamerSymbol: OptionStreamerSymbolSchema.parse(instrument.streamerSymbol),
    }
  })
  const streamerSymbols = resolved.map((contract) => contract.streamerSymbol)
  if (new Set(streamerSymbols).size !== streamerSymbols.length) {
    throw new Error('Requested option contracts did not resolve to unique market-data instruments.')
  }
  if (!env.MARKET_FEED) throw new Error('Live option Greeks are unavailable.')
  const observation = OptionGreeksReadResultSchema.parse(
    await env.MARKET_FEED.getByName('primary-account').readOptionGreeks(streamerSymbols),
  )
  const byStreamerSymbol = new Map(observation.greeks.map((greeks) => [greeks.streamerSymbol, greeks]))
  if (byStreamerSymbol.size !== streamerSymbols.length
    || observation.greeks.length !== streamerSymbols.length
    || streamerSymbols.some((symbol) => !byStreamerSymbol.has(symbol))) {
    throw new Error('Live option Greeks returned an incomplete or mismatched observation.')
  }
  return {
    asOf: observation.asOf,
    contracts: resolved.map(({ contract, sharesPerContract, streamerSymbol, symbol }) => ({
      ...contract,
      ...byStreamerSymbol.get(streamerSymbol)!,
      sharesPerContract,
      streamerSymbol,
      symbol,
    })),
    impliedVolatilityUnit: 'decimal_ratio',
    source: 'tastytrade-dxlink',
  }
}

export function createExactOptionGreeksReadTool(
  env: AppEnv,
): AgentTool<typeof ExactOptionGreeksReadParameters, ExactOptionGreeksReadResult> {
  return {
    description: 'Live broker IV and Greeks for exact option tuples.',
    execute: async (_toolCallId, params) => textResult(await readExactOptionGreeks(env, params)),
    label: 'Reading option Greeks',
    name: 'read_option_greeks',
    parameters: ExactOptionGreeksReadParameters,
  }
}
