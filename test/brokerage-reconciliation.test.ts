import { afterEach, describe, expect, it } from 'vitest'

import { matchesSubmittedOrder, reconcileUnknownBrokerageAction } from '../src/server/brokerage-reconciliation'
import { BrokerageSubmissionUnknownError } from '../src/server/brokerage'
import { buildOrderPayload } from '../src/server/order-payload'
import { placeBrokerageOrder } from '../src/server/order-placement'
import { brokerCredential, stubBroker } from './broker-stub'
import { tastytradeAdapter, tastytradeOrderRecord } from '../src/server/brokers/tastytrade'
import { resetBrokerAdapters, setBrokerAdapters } from '../src/server/brokers'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { resetInternalWatchlistWriter, setInternalWatchlistWriter } from '../src/server/internal-watchlist'
import { resetTradeGuards, setTradeGuards } from '../src/server/trade-guards'
import { type BrokerOrderRecord } from '../src/domain/broker'
import { type JsonObject, type JsonValue } from '../src/domain/json-payload'
import { type AppEnv } from '../src/server/env'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

let store: SqliteD1Store | undefined

afterEach(() => {
  store?.close()
  store = undefined
  resetBrokerApi()
  resetBrokerAdapters()
  resetInternalWatchlistWriter()
  resetTradeGuards()
})

describe('brokerage submission reconciliation', () => {
  const intended = buildOrderPayload({
    action: 'Buy to Open', expiry: '2026-09-18', kind: 'place_option_order', limitPrice: 2.5,
    optionType: 'C', priceEffect: 'Debit', quantity: 2, strike: 600, underlying: 'SPY',
  }, ['SPY   260918C00600000'])

  it('requires an exact payload fingerprint inside the submission window', () => {
    const rowOf = (overrides: JsonObject = {}) => tastytradeOrderRecord({
      id: '42', legs: intended.legs, 'order-type': 'Limit', price: '2.50',
      'price-effect': 'Debit', 'received-at': '2026-08-14T14:00:30.000Z', status: 'Live',
      'time-in-force': 'Day', 'updated-at': '2026-08-14T14:00:31.000Z',
      ...overrides,
    })
    const row = rowOf()
    expect(matchesSubmittedOrder(
      row, intended, new Date('2026-08-14T14:00:00.000Z'), new Date('2026-08-14T14:01:00.000Z'),
    )).toBe(true)
    expect(matchesSubmittedOrder(
      rowOf({ price: '2.55' }), intended, new Date('2026-08-14T14:00:00.000Z'), new Date('2026-08-14T14:01:00.000Z'),
    )).toBe(false)
    expect(matchesSubmittedOrder(
      rowOf({ 'received-at': '2026-08-13T14:00:00.000Z' }), intended,
      new Date('2026-08-14T14:00:00.000Z'), new Date('2026-08-14T14:01:00.000Z'),
    )).toBe(false)

    const replacementRow = rowOf({ 'replaces-order-id': '123' })
    expect(matchesSubmittedOrder(
      replacementRow, intended, new Date('2026-08-14T14:00:00.000Z'), new Date('2026-08-14T14:01:00.000Z'), '123',
    )).toBe(true)
    expect(matchesSubmittedOrder(
      replacementRow, intended, new Date('2026-08-14T14:00:00.000Z'), new Date('2026-08-14T14:01:00.000Z'), 'other',
    )).toBe(false)
  })

  it('does not report an unavailable reconciliation store as no quarantined action', async () => {
    await expect(reconcileUnknownBrokerageAction({}, brokerCredential)).rejects.toThrow('store-unavailable')
  })

  it('reconciles an ambiguous option order after its contract has left the chain', async () => {
    const contract = 'SPY   260918C00600000'
    const optionOrder = {
      action: 'Buy to Open' as const, expiry: '2026-09-18', kind: 'place_option_order' as const, limitPrice: 2.5,
      optionType: 'C' as const, priceEffect: 'Debit' as const, quantity: 2, strike: 600, underlying: 'SPY',
    }
    const orderBody = {
      id: 42, legs: intended.legs, 'order-type': 'Limit', price: '2.50', 'price-effect': 'Debit', 'time-in-force': 'Day',
    }
    let chainListsContract = true
    const chain = () => ({
      data: {
        items: chainListsContract
          ? [{
            active: true, 'expiration-date': '2026-09-18', 'instrument-type': 'Equity Option', 'is-closing-only': false,
            'option-chain-type': 'Standard', 'option-type': 'C', 'shares-per-contract': 100,
            'strike-price': '600.0', symbol: contract, 'underlying-symbol': 'SPY',
          }]
          : [],
      },
    })
    const brokerage = stubBroker()
    brokerage.resolveAccountNumber.mockResolvedValue('TEST123')
    brokerage.tastyRequest.mockImplementation(async (_env: AppEnv, path: string): Promise<JsonValue> => {
      if (path.startsWith('/option-chains/')) return chain()
      if (path.endsWith('/dry-run')) {
        return { data: { 'buying-power-effect': { effect: 'Debit' }, order: orderBody, warnings: [] } }
      }
      // The submission itself: a transport failure after sending, so it may have reached the market.
      throw new TypeError('fetch failed')
    })
    setBrokerApi(brokerage)
    setInternalWatchlistWriter({ ensureSymbols: async () => [] })
    setTradeGuards({
      assertOrderMarketSafe: async () => ({ ask: 2.6, bid: 2.4, observedAt: new Date().toISOString(), tickSize: 0.01 }),
      assertPortfolioActionAllowed: async () => undefined,
    })
    store = await migrationStore()
    const env = { DB: store.database }

    await expect(placeBrokerageOrder(env, optionOrder, brokerCredential))
      .rejects.toBeInstanceOf(BrokerageSubmissionUnknownError)
    const [claimed] = store.sqlite.prepare('SELECT submitted_at, resolved_payload_json FROM broker_submissions').all()
    expect(JSON.parse(String(claimed?.resolved_payload_json))).toEqual(intended)

    // The next morning the 0DTE contract is gone from the chain. Reconciliation must not need it.
    chainListsContract = false
    const chainReadsBefore = brokerage.tastyRequest.mock.calls.length
    const submittedAt = String(claimed?.submitted_at)
    const brokerRow: BrokerOrderRecord = tastytradeOrderRecord({
      ...orderBody, 'received-at': submittedAt, status: 'Filled', 'updated-at': submittedAt,
    })
    setBrokerAdapters({
      tastytrade: {
        ...tastytradeAdapter,
        readOrderHistory: async () => ({ complete: true, orders: [brokerRow] }),
        resolveAccountRef: async () => ({ accountNumber: 'TEST123', broker: 'tastytrade' }),
      },
    })

    await expect(reconcileUnknownBrokerageAction(env, brokerCredential))
      .resolves.toMatchObject({ providerOrderId: '42', status: 'executed' })
    expect(brokerage.tastyRequest.mock.calls.length).toBe(chainReadsBefore)
    expect(store.sqlite.prepare('SELECT status, provider_order_id FROM broker_submissions').all())
      .toEqual([{ provider_order_id: '42', status: 'executed' }])
  })

  it('refuses a stored order that disagrees with its stored action rather than trusting either', async () => {
    store = await migrationStore()
    store.sqlite.prepare(
      `INSERT INTO broker_submissions (id, broker_id, account_number, payload_json, resolved_payload_json, submitted_at, status)
       VALUES ('row-1', 'tastytrade', 'TEST123', ?, ?, ?, 'unresolved')`,
    ).run(
      JSON.stringify({
        action: 'Buy to Open', expiry: '2026-09-18', kind: 'place_option_order', limitPrice: 2.5,
        optionType: 'C', priceEffect: 'Debit', quantity: 2, strike: 600, underlying: 'SPY',
      }),
      JSON.stringify({ ...intended, price: '2.55' }),
      new Date().toISOString(),
    )
    setBrokerAdapters({
      tastytrade: {
        ...tastytradeAdapter,
        readOrderHistory: async () => ({ complete: true, orders: [] }),
        resolveAccountRef: async () => ({ accountNumber: 'TEST123', broker: 'tastytrade' }),
      },
    })

    await expect(reconcileUnknownBrokerageAction({ DB: store.database }, brokerCredential))
      .rejects.toThrow('stored-order-disagrees-with-action')
    expect(store.sqlite.prepare('SELECT status FROM broker_submissions').all()).toEqual([{ status: 'unresolved' }])
  })

  it('identifies a legacy row\'s contract even once it is closing-only and inactive', async () => {
    const brokerage = stubBroker()
    brokerage.tastyRequest.mockResolvedValue({
      data: {
        items: [{
          active: false, 'expiration-date': '2026-09-18', 'instrument-type': 'Equity Option', 'is-closing-only': true,
          'option-chain-type': 'Standard', 'option-type': 'C', 'shares-per-contract': 100,
          'strike-price': '600.0', symbol: 'SPY   260918C00600000', 'underlying-symbol': 'SPY',
        }],
      },
    })
    setBrokerApi(brokerage)
    store = await migrationStore()
    const submittedAt = new Date().toISOString()
    // A row claimed before the resolved order was stored: the action tuple only.
    store.sqlite.prepare(
      `INSERT INTO broker_submissions (id, broker_id, account_number, payload_json, submitted_at, status)
       VALUES ('legacy-1', 'tastytrade', 'TEST123', ?, ?, 'unresolved')`,
    ).run(JSON.stringify({
      action: 'Buy to Open', expiry: '2026-09-18', kind: 'place_option_order', limitPrice: 2.5,
      optionType: 'C', priceEffect: 'Debit', quantity: 2, strike: 600, underlying: 'SPY',
    }), submittedAt)
    setBrokerAdapters({
      tastytrade: {
        ...tastytradeAdapter,
        readOrderHistory: async () => ({
          complete: true,
          orders: [tastytradeOrderRecord({
            id: '43', legs: intended.legs, 'order-type': 'Limit', price: '2.50', 'price-effect': 'Debit',
            'received-at': submittedAt, status: 'Filled', 'time-in-force': 'Day',
          })],
        }),
        resolveAccountRef: async () => ({ accountNumber: 'TEST123', broker: 'tastytrade' }),
      },
    })

    await expect(reconcileUnknownBrokerageAction({ DB: store.database }, brokerCredential))
      .resolves.toMatchObject({ providerOrderId: '43', status: 'executed' })
  })
})
