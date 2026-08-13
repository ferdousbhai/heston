import { describe, expect, it } from 'vitest'

import { equityOptionContractFromChain } from '../src/server/option-contract'

const action = {
  kind: 'place_option_order' as const,
  underlying: 'NVDA',
  optionType: 'C' as const,
  strike: 250,
  expiry: '2026-08-14',
  action: 'Buy to Open' as const,
  quantity: 1,
  limitPrice: 0.01,
  priceEffect: 'Debit' as const,
}

function option(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'NVDA  260814C00250000',
    'instrument-type': 'Equity Option',
    active: true,
    'strike-price': '250.0',
    'root-symbol': 'NVDA',
    'underlying-symbol': 'NVDA',
    'expiration-date': '2026-08-14',
    'shares-per-contract': 100,
    'option-type': 'C',
    'option-chain-type': 'Standard',
    'is-closing-only': false,
    ...overrides,
  }
}

function payload(items: Array<Record<string, unknown>>) {
  return { data: { items } }
}

describe('equity option contract resolution', () => {
  it('resolves one exact active standard contract from detailed instruments', () => {
    expect(equityOptionContractFromChain(payload([
      option(),
      option({ symbol: 'NVDA  260814P00250000', 'option-type': 'P' }),
      option({ symbol: 'NVDA  260814C00255000', 'strike-price': '255.0' }),
    ]), action)).toEqual({ symbol: 'NVDA  260814C00250000', sharesPerContract: 100 })
  })

  it('rejects adjusted, inactive, closing-only, and ambiguous matches', () => {
    expect(() => equityOptionContractFromChain(payload([
      option({ 'option-chain-type': 'Adjusted' }),
    ]), action)).toThrow('Available standard expirations: none')
    expect(() => equityOptionContractFromChain(payload([
      option({ active: false }),
    ]), action)).toThrow('inactive')
    expect(() => equityOptionContractFromChain(payload([
      option({ 'is-closing-only': true }),
    ]), action)).toThrow('closing-only')
    expect(() => equityOptionContractFromChain(payload([
      option(), option({ symbol: 'NVDA2 260814C00250000' }),
    ]), action)).toThrow('ambiguous')
  })

  it('reports valid expirations or nearby strikes without guessing', () => {
    expect(() => equityOptionContractFromChain(payload([
      option({ 'expiration-date': '2026-08-21' }),
    ]), action)).toThrow('Available standard expirations: 2026-08-21')
    expect(() => equityOptionContractFromChain(payload([
      option({ 'strike-price': '245' }),
      option({ 'strike-price': '255', symbol: 'NVDA  260814C00255000' }),
    ]), action)).toThrow('Nearest call strikes: 245, 255')
  })
})
