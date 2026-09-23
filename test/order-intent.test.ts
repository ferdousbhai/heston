import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { brokerCredential, stubBroker } from './broker-stub'
import { buildOrderPayload } from '../src/server/order-payload'
import { assertReplaceableOrder, resolveOrderIntent } from '../src/server/order-intent'
import { tastytradeOrderFromPayload, tastytradeOrderRecord } from '../src/server/brokers/tastytrade'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { migrationStore } from './sqlite-d1'

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

  it('refuses a terminal order on the adapter\'s normalized flag, not a provider status word', () => {
    expect(tastytradeOrderRecord({ status: 'Live' }).terminal).toBe(false)
    expect(tastytradeOrderRecord({ status: 'Filled' }).terminal).toBe(true)
    expect(tastytradeOrderRecord({ status: 'Live', 'terminal-at': '2026-08-13T12:00:00Z' }).terminal).toBe(true)
    const order = {
      id: '123', editable: true, status: 'Live', ...intended,
      legs: intended.legs.map((leg) => ({ ...leg, 'remaining-quantity': leg.quantity, fills: [] })),
    }
    const record = tastytradeOrderFromPayload({ data: order })
    expect(() => assertReplaceableOrder(record, '123', intended)).not.toThrow()
    expect(() => assertReplaceableOrder({ ...record, terminal: true }, '123', intended))
      .toThrow('order-changed-or-not-editable')
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

  it('reads the source order only from the replacing account\'s own rows', async () => {
    const source = {
      kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open',
      quantity: 2, limitPrice: 700, priceEffect: 'Debit',
    }
    const order = {
      id: '123', editable: true, status: 'Live', ...intended,
      legs: intended.legs.map((leg) => ({ ...leg, 'remaining-quantity': leg.quantity, fills: [] })),
    }
    tastytrade.tastyRequest.mockResolvedValue({ data: order })
    const store = await migrationStore()
    try {
      // Another member's executed order that happens to carry the same broker order id.
      store.sqlite.prepare(
        `INSERT INTO broker_submissions (id, broker_id, account_number, payload_json, submitted_at, status, provider_order_id)
         VALUES ('other', 'tastytrade', 'OTHER', ?, '2026-09-01T00:00:00.000Z', 'executed', '123')`,
      ).run(JSON.stringify(source))
      const replace = { kind: 'replace_order' as const, orderId: '123', limitPrice: 699.5 }

      await expect(resolveOrderIntent({ DB: store.database }, replace, 'TEST', brokerCredential))
        .rejects.toThrow('OrderReplacement:source-order-not-found')
      expect(tastytrade.tastyRequest).not.toHaveBeenCalled()

      store.sqlite.prepare(
        `INSERT INTO broker_submissions (id, broker_id, account_number, payload_json, submitted_at, status, provider_order_id)
         VALUES ('mine', 'tastytrade', 'TEST', ?, '2026-09-01T00:00:00.000Z', 'executed', '123')`,
      ).run(JSON.stringify(source))
      await expect(resolveOrderIntent({ DB: store.database }, replace, 'TEST', brokerCredential))
        .resolves.toMatchObject({ replaceOrderId: '123' })
    } finally {
      store.close()
    }
  })
})
