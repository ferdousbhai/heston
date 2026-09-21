import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { brokerCredential, stubBroker } from './broker-stub'
import { buildOrderPayload } from '../src/server/order-payload'
import { assertReplaceableOrder, resolveOrderIntent } from '../src/server/order-intent'
import { tastytradeOrderFromPayload } from '../src/server/brokers/tastytrade'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'

const tastytrade = stubBroker()

beforeEach(() => setBrokerApi(tastytrade))
afterEach(() => resetBrokerApi())

describe('order replacement source boundary', () => {
  const intended = buildOrderPayload({
    kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open',
    quantity: 2, limitPrice: 700, priceEffect: 'Debit',
  }, ['SPY'])

  beforeEach(() => tastytrade.tastyRequest.mockReset())

  it('requires the exact unfilled editable live order', () => {
    const order = {
      id: '123', editable: true, status: 'Live', ...intended,
      legs: intended.legs.map((leg) => ({ ...leg, 'remaining-quantity': leg.quantity, fills: [] })),
    }
    expect(() => assertReplaceableOrder(tastytradeOrderFromPayload({ data: order }), '123', intended)).not.toThrow()
    expect(() => assertReplaceableOrder(tastytradeOrderFromPayload({ data: { ...order, editable: false } }), '123', intended)).toThrow()
    expect(() => assertReplaceableOrder(tastytradeOrderFromPayload({ data: {
      ...order,
      legs: [{ ...order.legs[0], 'remaining-quantity': 1, fills: [{ quantity: 1 }] }],
    } }), '123', intended)).toThrow()
  })

  it('expands a price-only replacement from the exact prior Heston action', async () => {
    const source = {
      kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open',
      quantity: 2, limitPrice: 700, priceEffect: 'Debit',
    }
    const order = {
      id: '123', editable: true, status: 'Live', ...intended,
      legs: intended.legs.map((leg) => ({ ...leg, 'remaining-quantity': leg.quantity, fills: [] })),
    }
    tastytrade.tastyRequest.mockResolvedValue({ data: order })
    const DB: D1Database = {
      ...unsupportedDatabase(),
      prepare: () => ({
        ...unsupportedStatement(),
        bind: () => ({
          ...unsupportedStatement(),
          all: vi.fn().mockResolvedValue(d1Result([{ payload_json: JSON.stringify(source) }])),
        }),
      }),
    }
    const env = { DB }

    const resolved = await resolveOrderIntent(
      env,
      { kind: 'replace_order', orderId: '123', limitPrice: 699.5 },
      'TEST',
      brokerCredential,
    )
    expect(resolved.replaceOrderId).toBe('123')
    expect(resolved.payload.price).toBe('699.50')
    expect(resolved.storedAction).toMatchObject({
      kind: 'replace_order', orderId: '123', limitPrice: 699.5,
      replacementOrder: { ...source, limitPrice: 699.5 },
    })
  })
})
