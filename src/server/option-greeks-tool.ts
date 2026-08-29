import { Type } from '@earendil-works/pi-ai'
import { type AgentTool } from '@earendil-works/pi-agent-core'
import { z } from 'zod'

import { EQUITY_SYMBOL_PATTERN, EquitySymbolSchema } from '../domain/instrument'
import { type AppEnv } from './env'
import {
  MAX_OPTION_GREEKS_CONTRACTS,
  OptionGreeksReadResultSchema,
  OptionStreamerSymbolSchema,
} from './market-feed-contracts'
import { textResult } from './agent-tool-result'
import {
  type EquityOptionTuple,
  resolveEquityOptionTuples,
} from './option-contract'

export const ExactOptionGreeksReadParameters = Type.Object({
  contracts: Type.Array(Type.Object({
    expiry: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' }),
    optionType: Type.Union([Type.Literal('C'), Type.Literal('P')]),
    strike: Type.Number({ exclusiveMinimum: 0 }),
    underlying: Type.String({ pattern: EQUITY_SYMBOL_PATTERN }),
  }, { additionalProperties: false }), {
    maxItems: MAX_OPTION_GREEKS_CONTRACTS,
    minItems: 1,
  }),
}, { additionalProperties: false })

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().startsWith(value)
})

const ExactOptionGreeksInputSchema = z.object({
  contracts: z.array(z.object({
    expiry: IsoDateSchema,
    optionType: z.enum(['C', 'P']),
    strike: z.number().finite().positive(),
    underlying: EquitySymbolSchema,
  }).strict()).min(1).max(MAX_OPTION_GREEKS_CONTRACTS),
}).strict()

export type ExactOptionGreeksReadInput = {
  contracts: EquityOptionTuple[]
}

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

function tupleKey(tuple: EquityOptionTuple): string {
  return `${tuple.underlying}|${tuple.expiry}|${tuple.optionType}|${tuple.strike}`
}

/** Resolve exact broker instruments server-side, then ask the shared MarketFeed DO for live Greeks. */
export async function readExactOptionGreeks(
  env: AppEnv,
  input: ExactOptionGreeksReadInput,
): Promise<ExactOptionGreeksReadResult> {
  const parsed = ExactOptionGreeksInputSchema.parse(input)
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
