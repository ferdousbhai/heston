import { describe, expect, it } from 'vitest'

import { tastytradeApiVersion } from '../src/server/tastytrade-version'

describe('tastytrade API version routing', () => {
  it('uses each endpoint family version and leaves unversioned APIs alone', () => {
    expect(tastytradeApiVersion('/accounts/A1/balances')).toBe('20240501')
    expect(tastytradeApiVersion('/accounts/A1/positions?include-marks=true')).toBe('20240501')
    expect(tastytradeApiVersion('/option-chains/NVDA')).toBe('20250715')
    expect(tastytradeApiVersion('/accounts/A1/orders/live?per-page=200')).toBe('20260427')
    expect(tastytradeApiVersion('/accounts/A1/complex-orders/dry-run')).toBe('20260427')
    expect(tastytradeApiVersion('/market-metrics?symbols=NVDA')).toBeUndefined()
    expect(tastytradeApiVersion('/watchlists')).toBeUndefined()
  })
})
