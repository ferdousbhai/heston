import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type AppEnv } from '../src/server/env'
import {
  createExactOptionGreeksReadTool,
  ExactOptionGreeksReadParameters,
  readExactOptionGreeks,
} from '../src/server/option-greeks-tool'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'

const mocks = stubBroker()

beforeEach(() => setBrokerApi(mocks))
afterEach(() => resetBrokerApi())

const contracts = [
  { expiry: '2026-08-14', optionType: 'C' as const, strike: 250, underlying: 'NVDA' },
  { expiry: '2026-08-14', optionType: 'P' as const, strike: 250, underlying: 'NVDA' },
]

function option(optionType: 'C' | 'P') {
  return {
    active: true,
    'expiration-date': '2026-08-14',
    'instrument-type': 'Equity Option',
    'option-chain-type': 'Standard',
    'option-type': optionType,
    'root-symbol': 'NVDAW',
    'shares-per-contract': 100,
    'streamer-symbol': `.NVDA260814${optionType}250`,
    'strike-price': '250',
    symbol: `NVDA  260814${optionType}00250000`,
    'underlying-symbol': 'NVDA',
  }
}

function observation(streamerSymbol: string, delta: number) {
  return {
    delta,
    eventAt: '2026-08-13T14:00:00.000Z',
    gamma: 0.03,
    impliedVolatility: 0.42,
    impliedVolatilityUnit: 'decimal_ratio' as const,
    optionPrice: 3.2,
    receivedAt: '2026-08-13T14:00:00.100Z',
    rho: 0.02,
    source: 'tastytrade-dxlink' as const,
    streamerSymbol,
    theta: -0.04,
    vega: 0.12,
  }
}

function environment(greeks: ReturnType<typeof observation>[]) {
  const readOptionGreeks = vi.fn().mockResolvedValue({
    asOf: '2026-08-13T14:00:00.100Z',
    greeks,
    impliedVolatilityUnit: 'decimal_ratio',
    source: 'tastytrade-dxlink',
  })
  const getByName = vi.fn(() => ({ fetch: vi.fn(), readOptionGreeks }))
  const env: AppEnv = { MARKET_FEED: { get: vi.fn(), getByName, idFromName: vi.fn() } }
  return { env, getByName, readOptionGreeks }
}

describe('exact option Greeks tool', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.tastyRequest.mockResolvedValue({ data: { items: [option('C'), option('P')] } })
  })

  it('resolves human tuples once per underlying and reads exact streamer symbols through the shared DO', async () => {
    const { env, getByName, readOptionGreeks } = environment([
      observation('.NVDA260814C250', 0.5),
      observation('.NVDA260814P250', -0.5),
    ])
    const result = await readExactOptionGreeks(env, { contracts })
    expect(mocks.tastyRequest).toHaveBeenCalledTimes(1)
    expect(mocks.tastyRequest).toHaveBeenCalledWith(env, '/option-chains/NVDA')
    expect(getByName).toHaveBeenCalledWith('primary-account')
    expect(readOptionGreeks).toHaveBeenCalledWith(['.NVDA260814C250', '.NVDA260814P250'])
    expect(result.contracts).toMatchObject([
      { ...contracts[0], delta: 0.5, sharesPerContract: 100, streamerSymbol: '.NVDA260814C250' },
      { ...contracts[1], delta: -0.5, sharesPerContract: 100, streamerSymbol: '.NVDA260814P250' },
    ])
    expect(result).toMatchObject({
      impliedVolatilityUnit: 'decimal_ratio',
      source: 'tastytrade-dxlink',
    })
  })

  it('does not expose or accept raw streamer-symbol inputs', async () => {
    expect(JSON.stringify(ExactOptionGreeksReadParameters)).not.toContain('streamer')
    const { env } = environment([observation('.NVDA260814C250', 0.5)])
    const smuggledStreamerSymbol = { ...contracts[0], streamerSymbol: '.ATTACKER' }
    await expect(readExactOptionGreeks(env, { contracts: [smuggledStreamerSymbol] })).rejects.toThrow()
    expect(createExactOptionGreeksReadTool(env).name).toBe('read_option_greeks')
  })

  it('fails closed on incomplete or mismatched DO observations', async () => {
    const { env } = environment([observation('.NVDA260814C250', 0.5)])
    await expect(readExactOptionGreeks(env, { contracts })).rejects.toThrow('incomplete or mismatched')
  })
})
