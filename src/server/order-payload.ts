import { z } from 'zod'

import { type FreshOrderPlacement } from './agent-contracts'
import { type BrokerOrderRecord } from '../domain/broker'
import { CallerVisibleError } from './caller-visible-error'

/**
 * The order body Spice sends, as a schema so a stored copy can be read back at the D1 boundary
 * rather than trusted. Exact literals where the builder only ever writes one value.
 */
export const OrderPayloadSchema = z.strictObject({
  'advanced-instructions': z.strictObject({ 'strict-position-effect-validation': z.literal(true) }).optional(),
  'order-type': z.literal('Limit'),
  'price-effect': z.enum(['Credit', 'Debit']),
  'time-in-force': z.literal('Day'),
  legs: z.array(z.strictObject({
    action: z.string().min(1),
    'instrument-type': z.enum(['Equity', 'Equity Option']),
    quantity: z.number().int().positive(),
    symbol: z.string().min(1),
  })).min(1),
  price: z.string().min(1),
})

export type OrderPayload = z.infer<typeof OrderPayloadSchema>

export function buildOrderPayload(
  action: FreshOrderPlacement,
  resolvedSymbols: readonly string[],
): OrderPayload {
  const legs: OrderPayload['legs'] = action.kind === 'place_vertical_spread_order'
    ? [
        { action: 'Buy to Open', 'instrument-type': 'Equity Option', quantity: action.quantity, symbol: resolvedSymbols[0]! },
        { action: 'Sell to Open', 'instrument-type': 'Equity Option', quantity: action.quantity, symbol: resolvedSymbols[1]! },
      ]
    : [{
        action: action.action,
        'instrument-type': action.kind === 'place_option_order' ? 'Equity Option' : 'Equity',
        quantity: action.quantity,
        symbol: resolvedSymbols[0]!,
      }]
  if (legs.some((leg) => !leg.symbol)) throw new CallerVisibleError('OrderPayload:missing-resolved-symbol')
  const payload: OrderPayload = {
    'order-type': 'Limit',
    'price-effect': action.priceEffect,
    'time-in-force': 'Day',
    legs,
    price: action.limitPrice.toFixed(2),
  }
  // Closing legs must never be re-opened by the broker if the position moved underneath us.
  if (legs.some((leg) => leg.action.endsWith('to Close'))) {
    payload['advanced-instructions'] = { 'strict-position-effect-validation': true }
  }
  return payload
}

/** tastytrade replacements preserve the existing legs; sending them again can be rejected. */
export function replacementOrderPayload(payload: OrderPayload): Omit<OrderPayload, 'legs'> {
  const { legs: _legs, ...replacement } = payload
  return replacement
}

/**
 * Whether a broker's own record of an order states exactly the order Spice built: type, time in
 * force, price effect, price, and every leg in order. The dry-run and placement receipts, the
 * replacement receipt, the replaceable-order check and the reconciliation match all start here
 * and add only what is specific to them, so the rule cannot drift between them. An unreadable
 * field is "not this order", never repaired.
 *
 * Prices compare exactly. `price` is built with `toFixed(2)` and the broker echoes a decimal;
 * the same decimal parses to the same double, so equality holds for the same price, and any
 * tolerance could only ever admit a price that was not the one submitted.
 */
export function echoesOrderPayload(record: BrokerOrderRecord, intended: OrderPayload): boolean {
  const legs = record.legs
  return record.orderType === intended['order-type']
    && record.timeInForce === intended['time-in-force']
    && record.priceEffect === intended['price-effect']
    && record.price === Number(intended.price)
    && legs?.length === intended.legs.length
    && intended.legs.every((leg, index) => {
      const actual = legs[index]
      return actual?.action === leg.action
        && actual.instrumentType === leg['instrument-type']
        && actual.symbol === leg.symbol
        && actual.quantity === leg.quantity
    })
}

/** Field-by-field equality of two built orders; key order in a stored copy is irrelevant. */
export function sameOrderPayload(left: OrderPayload, right: OrderPayload): boolean {
  return left['order-type'] === right['order-type']
    && left['price-effect'] === right['price-effect']
    && left['time-in-force'] === right['time-in-force']
    && left.price === right.price
    && left['advanced-instructions']?.['strict-position-effect-validation']
      === right['advanced-instructions']?.['strict-position-effect-validation']
    && left.legs.length === right.legs.length
    && left.legs.every((leg, index) => {
      const other = right.legs[index]
      return other !== undefined
        && leg.action === other.action
        && leg['instrument-type'] === other['instrument-type']
        && leg.quantity === other.quantity
        && leg.symbol === other.symbol
    })
}
