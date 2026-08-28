import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type JsonValue } from '../src/domain/json-payload'

import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { buildAgentRuntimeContext, loadBrokerageContext } from '../src/server/brokerage-context'

const tastytrade = stubBroker()

beforeEach(() => setBrokerApi(tastytrade))
afterEach(() => resetBrokerApi())

const balance = {
  'account-number': 'A1',
  'available-trading-funds': '61000',
  'cash-available-to-withdraw': '65000',
  'cash-balance': '70000',
  'day-trading-buying-power': '320000',
  'derivative-buying-power': '80000',
  'equity-buying-power': '160000',
  'net-liquidating-value': '100000',
}

type BrokerPage = { data: { items: JsonValue[] } }

function pageFor(path: string): BrokerPage {
  if (path.includes('/positions')) return { data: { items: [{
    symbol: 'SPY option',
    'underlying-symbol': 'SPY',
    quantity: '2',
    'quantity-direction': 'Long',
    'instrument-type': 'Equity Option',
    'average-open-price': '1.1',
    'mark-price': '1.25',
    'expires-at': '2026-09-18T20:00:00Z',
  }] } }
  if (path.includes('/complex-orders/live')) return { data: { items: [] } }
  if (path.includes('/orders/live')) return { data: { items: [{
    id: '101', status: 'Live', 'order-type': 'Limit', price: '1.20',
    'price-effect': 'Debit', 'time-in-force': 'Day',
    legs: [
      { action: 'Buy to Open', quantity: '1', symbol: 'SPY call', 'instrument-type': 'Equity Option' },
      { action: 'Sell to Open', quantity: '1', symbol: 'SPY call short', 'instrument-type': 'Equity Option' },
    ],
  }] } }
  if (path.includes('/transactions?')) return { data: { items: [{
    'transaction-type': 'Trade', 'executed-at': '2026-08-13T12:00:00Z',
    'order-id': 101, action: 'Buy to Open', quantity: '2', price: '1.20',
    symbol: 'SPY option', 'underlying-symbol': 'SPY', 'instrument-type': 'Equity Option',
  }] } }
  throw new Error(`Unexpected path: ${path}`)
}

function payloadFor(path: string): JsonValue {
  return path.endsWith('/balances') ? { data: balance } : pageFor(path)
}

describe('always-on brokerage context', () => {
  beforeEach(() => {
    tastytrade.resolveAccountNumber.mockReset().mockResolvedValue('A1')
    tastytrade.tastyRequest.mockReset().mockImplementation((_env, path: string) => Promise.resolve(payloadFor(path)))
  })

  it('loads accurately named balances and compact account state without exposing account identity', async () => {
    const context = await loadBrokerageContext({})
    const runtime = buildAgentRuntimeContext(context, [])

    expect(context.balances).toMatchObject({
      cashBalance: 70_000,
      cashAvailableToWithdraw: 65_000,
      availableTradingFunds: 61_000,
      equityBuyingPower: 160_000,
      derivativeBuyingPower: 80_000,
      dayTradingBuyingPower: 320_000,
      netLiquidatingValue: 100_000,
    })
    expect(context.positions[0]).toMatchObject({
      averageOpenPrice: 1.1, expiresAt: '2026-09-18T20:00:00Z',
    })
    expect(context.positions[0]).not.toHaveProperty('markPrice')
    expect(context.orders[0]?.legs).toHaveLength(2)
    expect(context.recentTrades[0]).toMatchObject({ orderId: '101', symbol: 'SPY option' })
    expect(context.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(context.source).toBe('tastytrade')
    expect(context.completeness).toEqual({
      ordersTruncated: false, positionsTruncated: false, tradesTruncated: false,
    })
    expect(JSON.stringify(runtime)).not.toContain('A1')
    expect(runtime).toMatchObject({
      source: 'tastytrade',
      completeness: { ordersTruncated: false, positionsTruncated: false, tradesTruncated: false },
      balances: { availableTradingFunds: 61_000, cashBalance: 70_000 },
      orders: [{ id: '101', legs: [{ symbol: 'SPY call' }, { symbol: 'SPY call short' }] }],
      recentTrades: [{ orderId: '101' }],
    })
    expect(tastytrade.tastyRequest).toHaveBeenCalledWith({}, expect.stringContaining('/transactions?type=Trade'))
  })

  it('marks fulfilled malformed collections unavailable instead of treating them as empty', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/positions') || path.includes('/orders/live') || path.includes('/transactions?')) {
        return Promise.resolve({ data: { unexpected: [] } })
      }
      return Promise.resolve(payloadFor(path))
    })

    const context = await loadBrokerageContext({})
    expect(context.availability).toMatchObject({ positions: false, orders: false, trades: false })
    expect(context.positions).toEqual([])
    expect(context.orders).toEqual([])
    expect(context.recentTrades).toEqual([])
    expect(buildAgentRuntimeContext(context, [])).toMatchObject({
      unavailable: expect.arrayContaining(['positions', 'orders', 'trades']),
    })
  })

  it('fails working-order completeness closed when the broker reports another page', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/orders/live')) {
        const base = pageFor(path)
        return Promise.resolve({ ...base, pagination: { 'total-items': 2 } })
      }
      return Promise.resolve(payloadFor(path))
    })

    const context = await loadBrokerageContext({})
    expect(context.availability.orders).toBe(false)
    expect(context.completeness.ordersTruncated).toBe(true)
    expect(context.orders).toEqual([])
  })

  it('fails position completeness closed when the broker reports another page', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/positions')) {
        const base = pageFor(path)
        return Promise.resolve({ ...base, pagination: { 'total-items': 2 } })
      }
      return Promise.resolve(payloadFor(path))
    })

    const context = await loadBrokerageContext({})
    expect(context.availability.positions).toBe(false)
    expect(context.completeness.positionsTruncated).toBe(true)
    expect(context.positions).toEqual([])
  })

  it('fails position completeness closed on a full page without pagination metadata', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/positions')) {
        return Promise.resolve({ data: { items: Array.from({ length: 200 }, (_, index) => ({
          symbol: `POS${index}`, 'underlying-symbol': 'SPY', quantity: '1',
          'quantity-direction': 'Long', 'instrument-type': 'Equity',
        })) } })
      }
      return Promise.resolve(payloadFor(path))
    })

    const context = await loadBrokerageContext({})
    expect(context.availability.positions).toBe(false)
    expect(context.completeness.positionsTruncated).toBe(true)
    expect(context.positions).toEqual([])
  })

  it('fails working-order completeness closed on a full page without pagination metadata', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/orders/live')) {
        return Promise.resolve({ data: { items: Array.from({ length: 200 }, (_, index) => ({
          id: String(index + 1), status: 'Filled', 'terminal-at': '2026-08-13T12:00:00Z',
        })) } })
      }
      return Promise.resolve(payloadFor(path))
    })

    const context = await loadBrokerageContext({})
    expect(context.availability.orders).toBe(false)
    expect(context.completeness.ordersTruncated).toBe(true)
    expect(context.orders).toEqual([])
  })

  it('marks a full recent-trade page as truncated when pagination is unavailable', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/transactions?')) {
        const row = pageFor(path).data.items[0]
        return Promise.resolve({ data: { items: Array.from({ length: 25 }, () => row) } })
      }
      return Promise.resolve(payloadFor(path))
    })

    const context = await loadBrokerageContext({})
    expect(context.completeness.tradesTruncated).toBe(true)
    expect(context.recentTrades).toHaveLength(25)
  })
})
