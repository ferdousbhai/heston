import { type FreshOrderPlacement } from './agent-contracts'

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
  if (legs.some((leg) => !leg.symbol)) throw new Error('OrderPayload:missing-resolved-symbol')
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
