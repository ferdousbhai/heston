import { afterEach, describe, expect, it, vi } from 'vitest'

import { executeBrokerageAction } from '../src/server/brokerage'
import { type AppEnv } from '../src/server/env'

function secret(value: string): SecretsStoreSecret {
  return { get: async () => value } as SecretsStoreSecret
}

function highWaterDb(value: number): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind() { return this },
      run: async () => ({ success: true, meta: { changes: 1 } }),
      first: async () => ({ high_water_nlv: value }),
    })),
  } as unknown as D1Database
}

afterEach(() => vi.unstubAllGlobals())

describe('brokerage dispatch portfolio guard', () => {
  it('fails before dry-run or submission when fresh positions contain unbounded exposure', async () => {
    const calls: Array<{ method: string; url: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 900 })
      if (url.includes('/positions')) return Response.json({ data: { items: [{
        symbol: 'SPY   260918C00700000', 'instrument-type': 'Equity Option',
        'quantity-direction': 'Short', quantity: '1',
      }] } })
      if (url.includes('/balances')) return Response.json({ data: {
        'net-liquidating-value': '100000', 'cash-balance': '65000',
        'cash-available-to-withdraw': '65000',
      } })
      if (url.includes('/complex-orders/live')) return Response.json({ data: { items: [] } })
      if (url.includes('/orders/live')) return Response.json({ data: { items: [] } })
      if (url.includes('/option-chains/')) return Response.json({ data: { items: [{
        symbol: 'SPY   260918C00700000', 'instrument-type': 'Equity Option', active: true,
        'underlying-symbol': 'SPY', 'root-symbol': 'SPY', 'option-chain-type': 'Standard',
        'shares-per-contract': 100, 'expiration-date': '2026-09-18', 'strike-price': '700',
        'option-type': 'C', 'is-closing-only': false,
      }] } })
      throw new Error(`Unexpected request: ${method} ${url}`)
    }))
    const env: AppEnv = {
      DB: highWaterDb(100_000),
      TASTYTRADE_ACCOUNT_NUMBER: secret('TEST123'),
      TASTYTRADE_CLIENT_SECRET: secret('client'),
      TASTYTRADE_REFRESH_TOKEN: secret('refresh'),
    }

    await expect(executeBrokerageAction(env, {
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Buy to Open', quantity: 1, limitPrice: 5,
      priceEffect: 'Debit',
    })).rejects.toThrow('Existing short, futures, or unsupported exposure')

    expect(calls.some((call) => call.url.includes('/orders/dry-run'))).toBe(false)
    expect(calls.some((call) => call.method === 'POST' && /\/accounts\/[^/]+\/orders$/.test(call.url))).toBe(false)
  })
})
