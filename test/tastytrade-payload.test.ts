import { describe, expect, it } from 'vitest'

import {
  accountBalanceRecord,
  accountBalancesFromPayload,
  isWorkingOrderRecord,
  workingOrderRecords,
} from '../src/server/brokers/tastytrade-payload'

const balance = {
  'account-number': 'A1',
  'net-liquidating-value': '100000',
  'cash-balance': '65000',
  'cash-available-to-withdraw': '65000',
  'available-trading-funds': '64000',
  'equity-buying-power': '128000',
  'derivative-buying-power': '64000',
  'day-trading-buying-power': '256000',
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

  it('requires and accurately names the complete agent balance snapshot', () => {
    expect(accountBalancesFromPayload({ data: balance }, 'A1')).toEqual({
      availableTradingFunds: 64_000,
      cashAvailableToWithdraw: 65_000,
      cashBalance: 65_000,
      dayTradingBuyingPower: 256_000,
      derivativeBuyingPower: 64_000,
      equityBuyingPower: 128_000,
      netLiquidatingValue: 100_000,
    })
    expect(() => accountBalancesFromPayload({ data: { ...balance, 'available-trading-funds': 'NaN' } }, 'A1'))
      .toThrow('invalid-available-trading-funds')
  })
})

describe('tastytrade live order payloads', () => {
  it('keeps active and unfamiliar states while excluding verified terminal rows', () => {
    expect(isWorkingOrderRecord({ status: 'Live', 'terminal-at': null })).toBe(true)
    expect(isWorkingOrderRecord({ status: 'Partially Filled' })).toBe(true)
    expect(isWorkingOrderRecord({})).toBe(true)
    expect(isWorkingOrderRecord({ status: 'Filled' })).toBe(false)
    expect(isWorkingOrderRecord({ status: 'Cancelled', 'terminal-at': '2026-08-13T12:00:00Z' })).toBe(false)
  })

  it('preserves complete compact legs and execution fields for ordinary and complex orders', () => {
    const ordinary = {
      id: '100',
      status: 'Live',
      'order-type': 'Limit',
      price: '1.25',
      'price-effect': 'Debit',
      'time-in-force': 'GTC',
      legs: [
        { action: 'Buy to Open', quantity: '1', symbol: 'SPY call', 'instrument-type': 'Equity Option' },
        { action: 'Sell to Open', quantity: '1', symbol: 'SPY call short', 'instrument-type': 'Equity Option' },
      ],
    }
    expect(workingOrderRecords(ordinary)).toEqual([{
      id: '100',
      status: 'Live',
      type: 'Limit',
      price: 1.25,
      priceEffect: 'Debit',
      timeInForce: 'GTC',
      symbol: 'SPY call',
      legs: [
        { action: 'Buy to Open', quantity: 1, symbol: 'SPY call', instrumentType: 'Equity Option' },
        { action: 'Sell to Open', quantity: 1, symbol: 'SPY call short', instrumentType: 'Equity Option' },
      ],
    }])
    expect(workingOrderRecords({ id: 'complex-1', orders: [ordinary] })).toEqual([
      expect.objectContaining({ id: '100', complexOrderId: 'complex-1' }),
    ])
    expect(() => workingOrderRecords({ id: 'broken', status: 'Live' })).toThrow('invalid-complex-order')
  })
})
