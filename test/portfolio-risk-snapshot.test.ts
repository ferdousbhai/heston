import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadBrokerageContext } from '../src/server/brokerage-context'
import { assertPortfolioActionAllowed } from '../src/server/portfolio-risk'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { type JsonValue } from '../src/domain/json-payload'
import { brokerCredential, stubBroker } from './broker-stub'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'

/**
 * The account context and the drawdown guard read one broker snapshot now. These pin the
 * union of what the two separate readers used to reject, and the guard's own wording for
 * each — those messages reach a member's agent.
 */

const tastytrade = stubBroker()

function highWaterDb(value: number): D1Database {
  const statement = {
    ...unsupportedStatement(),
    bind: (): D1PreparedStatement => statement,
    run: async () => d1Result([], 1),
    first: async () => ({ high_water_nlv: value }),
  }
  return { ...unsupportedDatabase(), prepare: vi.fn(() => statement) }
}

const balances = {
  'available-trading-funds': '64000',
  'cash-available-to-withdraw': '65000',
  'cash-balance': '65000',
  'day-trading-buying-power': '256000',
  'derivative-buying-power': '64000',
  'equity-buying-power': '128000',
  'net-liquidating-value': '100000',
}

const longEquity = {
  symbol: 'SPY', 'underlying-symbol': 'SPY', 'instrument-type': 'Equity',
  'quantity-direction': 'Long', quantity: '10',
}

const openEquityOrder = {
  kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open',
  quantity: 1, limitPrice: 700, priceEffect: 'Debit',
} as const

type Overrides = Partial<Record<'balances' | 'complex' | 'orders' | 'positions', JsonValue>>

function respondWith(overrides: Overrides = {}) {
  tastytrade.tastyRequest.mockReset().mockImplementation((_env, path: string) => {
    if (path.includes('/balances')) return Promise.resolve(overrides.balances ?? { data: balances })
    if (path.includes('/complex-orders/live')) return Promise.resolve(overrides.complex ?? { data: { items: [] } })
    if (path.includes('/orders/live')) return Promise.resolve(overrides.orders ?? { data: { items: [] } })
    if (path.includes('/positions')) return Promise.resolve(overrides.positions ?? { data: { items: [longEquity] } })
    throw new Error(`Unexpected path: ${path}`)
  })
}

function guard(env = { DB: highWaterDb(100_000) }, resolved = {}) {
  return assertPortfolioActionAllowed(env, openEquityOrder, brokerCredential, resolved)
}

beforeEach(() => {
  setBrokerApi(tastytrade)
  tastytrade.resolveAccountNumber.mockReset().mockResolvedValue('TEST123')
  respondWith()
})

afterEach(() => resetBrokerApi())

describe('drawdown guard over the merged account snapshot', () => {
  it('allows a bounded opening debit against a complete, long-only account', async () => {
    await expect(guard()).resolves.toMatchObject({ allowed: true, maxLoss: 700 })
  })

  it('names the incomplete read rather than under-reporting the account', async () => {
    respondWith({ positions: { data: { items: [longEquity] }, pagination: { 'total-items': 2 } } })
    await expect(guard()).rejects.toThrow(
      'The portfolio guard could not verify every open position: TastytradeAccount:incomplete-positions.',
    )

    respondWith({ orders: { data: { items: [] }, pagination: { 'total-items': 1 } } })
    await expect(guard()).rejects.toThrow(
      'The portfolio guard could not verify every ordinary live order: TastytradeAccount:incomplete-orders.',
    )

    respondWith({ complex: { data: { items: [] }, pagination: { 'total-items': 1 } } })
    await expect(guard()).rejects.toThrow(
      'The portfolio guard could not verify every complex live order: TastytradeAccount:incomplete-complex-orders.',
    )

    respondWith({ balances: { data: { items: [] } } })
    await expect(guard()).rejects.toThrow(
      'The portfolio guard could not verify balances: TastytradePayload:invalid-account-balance-record.',
    )
  })

  it('refuses an unsupported position record instead of skipping it', async () => {
    respondWith({ positions: { data: { items: [{ ...longEquity, 'quantity-direction': 'Sideways' }] } } })
    await expect(guard()).rejects.toThrow('The portfolio guard found an unsupported position record.')
  })

  // Newly rejected here: the guard used to parse positions loosely enough that a row with no
  // underlying symbol passed, while the account context refused it. The merged read takes the
  // stricter of the two, so an unidentifiable position now stops a trade rather than sizing it.
  it('refuses a position the broker did not name an underlying for', async () => {
    const { 'underlying-symbol': _dropped, ...unnamed } = longEquity
    respondWith({ positions: { data: { items: [unnamed] } } })
    await expect(guard()).rejects.toThrow('The portfolio guard found an unsupported position record.')
  })

  // Newly rejected here for the same reason: the guard used to count live-order rows without
  // parsing them, so a malformed working order silently became "one live order".
  it('refuses a malformed live order instead of counting it', async () => {
    respondWith({ orders: { data: { items: [{ id: '5', status: 'Live', 'order-type': 'Limit', legs: [] }] } } })
    await expect(guard()).rejects.toThrow(
      'The portfolio guard could not verify every ordinary live order: TastytradePayload:invalid-working-order.',
    )
  })

  it('reports a broker that would not answer separately from one that answered badly', async () => {
    tastytrade.tastyRequest.mockReset().mockRejectedValue(new Error('TastytradeApi:503:/accounts/[redacted]/positions'))
    await expect(guard()).rejects.toThrow('The portfolio guard could not refresh the complete brokerage account.')
  })

  it('refuses a non-positive net liquidation value and a negative cash reserve', async () => {
    respondWith({ balances: { data: { ...balances, 'net-liquidating-value': '0' } } })
    await expect(guard()).rejects.toThrow(
      'The portfolio guard could not verify net liquidation value and unencumbered cash.',
    )

    respondWith({ balances: { data: { ...balances, 'cash-balance': '-1' } } })
    await expect(guard()).rejects.toThrow('The portfolio guard found a negative cash reserve.')
  })
})

describe('live order counting', () => {
  const liveOrder = {
    id: '101', status: 'Live', 'order-type': 'Limit', price: '1.20',
    'price-effect': 'Debit', 'time-in-force': 'Day',
    legs: [{ action: 'Buy to Open', quantity: '1', symbol: 'SPY', 'instrument-type': 'Equity' }],
  }

  it('blocks on a live order and exempts only the order a replacement replaces', async () => {
    respondWith({ orders: { data: { items: [liveOrder] } } })
    await expect(guard()).rejects.toThrow('Cancel or wait for every live order before placing another trade.')
    await expect(guard(undefined, { ignoredOrderId: '101' })).resolves.toMatchObject({ allowed: true })
  })

  // The guard counts the rows the broker listed, not the expanded working orders: expansion
  // drops a complex order whose children have all gone terminal, and that order still occupies
  // the account. The account context, which reports individual working orders, sees none.
  it('still blocks on a complex live order whose children are all terminal', async () => {
    const complex = { data: { items: [{
      id: 'c1', status: 'Received',
      orders: [{ id: 'c1a', status: 'Filled', 'terminal-at': '2026-09-03T12:00:00Z' }],
    }] } }
    respondWith({ complex })

    await expect(guard()).rejects.toThrow('Cancel or wait for every live order before placing another trade.')
    const context = await loadBrokerageContext({}, brokerCredential)
    expect(context.orders).toEqual([])
    expect(context.liveOrders).toEqual([{ id: 'c1', source: 'complex' }])
  })

  // Only the ordinary row a replacement replaces is exempt. A complex order sharing that id
  // is a different order and must keep blocking.
  it('never exempts a complex order row from the count', async () => {
    respondWith({ complex: { data: { items: [{
      id: '101', status: 'Received', orders: [{ ...liveOrder, id: '101a' }],
    }] } } })
    await expect(guard(undefined, { ignoredOrderId: '101' }))
      .rejects.toThrow('Cancel or wait for every live order before placing another trade.')
  })
})
