import { beforeEach, describe, expect, it, vi } from 'vitest'

const tastytrade = vi.hoisted(() => ({ tastyRequest: vi.fn() }))
vi.mock('../src/server/tastytrade', () => tastytrade)

import { buildOrderPayload } from '../src/server/order-payload'
import { assertReplaceableOrder, resolveOrderIntent } from '../src/server/order-intent'

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
    expect(() => assertReplaceableOrder({ data: order }, '123', intended)).not.toThrow()
    expect(() => assertReplaceableOrder({ data: { ...order, editable: false } }, '123', intended)).toThrow()
    expect(() => assertReplaceableOrder({ data: {
      ...order,
      legs: [{ ...order.legs[0], 'remaining-quantity': 1, fills: [{ quantity: 1 }] }],
    } }, '123', intended)).toThrow()
  })

  it('expands a price-only replacement from the exact prior Spice action', async () => {
    const source = {
      kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open',
      quantity: 2, limitPrice: 700, priceEffect: 'Debit',
    }
    const order = {
      id: '123', editable: true, status: 'Live', ...intended,
      legs: intended.legs.map((leg) => ({ ...leg, 'remaining-quantity': leg.quantity, fills: [] })),
    }
    tastytrade.tastyRequest.mockResolvedValue({ data: order })
    const env = {
      DB: {
        prepare: () => ({
          bind: () => ({ all: async () => ({ results: [{ payload_json: JSON.stringify(source) }] }) }),
        }),
      } as unknown as D1Database,
    }

    const resolved = await resolveOrderIntent(env, { kind: 'replace_order', orderId: '123', limitPrice: 699.5 }, 'TEST')
    expect(resolved.replaceOrderId).toBe('123')
    expect(resolved.payload.price).toBe('699.50')
    expect(resolved.storedAction).toMatchObject({
      kind: 'replace_order', orderId: '123', limitPrice: 699.5,
      replacementOrder: { ...source, limitPrice: 699.5 },
    })
  })
})
