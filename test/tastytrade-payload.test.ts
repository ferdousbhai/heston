import { describe, expect, it } from 'vitest'

import { accountBalanceRecord } from '../src/server/tastytrade-payload'

const balance = {
  'account-number': 'A1',
  'net-liquidating-value': '100000',
  'cash-balance': '65000',
  'cash-available-to-withdraw': '65000',
}

describe('tastytrade balance payloads', () => {
  it('normalizes direct and single-item envelopes for the requested account', () => {
    expect(accountBalanceRecord({ data: balance }, 'A1')).toEqual(balance)
    expect(accountBalanceRecord({ data: { items: [balance] } }, 'A1')).toEqual(balance)
  })

  it('rejects ambiguous or mismatched account records', () => {
    expect(accountBalanceRecord({ data: { items: [balance, balance] } }, 'A1')).toBeUndefined()
    expect(accountBalanceRecord({ data: { items: [balance] } }, 'A2')).toBeUndefined()
  })
})
