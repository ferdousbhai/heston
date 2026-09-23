import { type FreshOrderPlacement } from './agent-contracts'
import { type BrokerOrderRecord } from '../domain/broker'
import { CallerVisibleError } from './caller-visible-error'

export type OrderPayload = {
  'advanced-instructions'?: { 'strict-position-effect-validation': true }
  'order-type': 'Limit'
  'price-effect': 'Credit' | 'Debit'
  'time-in-force': 'Day'
  legs: Array<{
    action: string
    'instrument-type': 'Equity' | 'Equity Option'
    quantity: number
    symbol: string
  }>
  price: string
}

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
 * Whether a broker's own record of an order states exactly the order Heston built: type, time in
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
