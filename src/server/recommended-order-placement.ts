import {
  ActionableRecommendedOrderSchema,
  type ActionableRecommendedOrder,
  recommendedOrderIssues,
} from '../domain/recommended-order'
import {
  FreshOrderPlacementSchema,
  type FreshOrderPlacement,
} from './agent-contracts'

export interface RecommendedOrderExecutionTerms {
  limitPrice: number
  quantity: number
}

/**
 * Promote research terms into the guarded placement shape only after a caller supplies fresh sizing and
 * pricing. Parsing here is intentional: the resulting draft still passes every normal guard,
 * broker dry-run, and confirmation step, and this function never places an order.
 */
export function orderPlacementFromRecommendedOrder(
  order: ActionableRecommendedOrder,
  execution: RecommendedOrderExecutionTerms,
): FreshOrderPlacement {
  const parsed = ActionableRecommendedOrderSchema.parse(order)
  const firstLeg = parsed.legs[0]!
  const symbol = 'symbol' in firstLeg ? firstLeg.symbol : firstLeg.contract.underlying
  const direction = 'symbol' in firstLeg
    ? firstLeg.action === 'Buy to Open' ? 'bullish' : 'bearish'
    : firstLeg.contract.optionType === 'C' ? 'bullish' : 'bearish'
  const issues = recommendedOrderIssues(parsed, symbol, direction)
  if (issues.length) throw new Error(`RecommendedOrderPlacement:${issues.join('; ')}`)

  if (parsed.kind === 'equity') {
    const leg = parsed.legs[0]!
    return FreshOrderPlacementSchema.parse({
      ...execution,
      action: leg.action,
      kind: 'place_equity_order',
      priceEffect: leg.action.startsWith('Buy') ? 'Debit' : 'Credit',
      symbol: leg.symbol,
    })
  }
  const longContract = parsed.legs[0]!.contract
  if (parsed.kind === 'equity-option') {
    return FreshOrderPlacementSchema.parse({
      ...execution,
      action: 'Buy to Open',
      expiry: longContract.expiry,
      kind: 'place_option_order',
      optionType: longContract.optionType,
      priceEffect: 'Debit',
      strike: longContract.strike,
      underlying: longContract.underlying,
    })
  }
  return FreshOrderPlacementSchema.parse({
    ...execution,
    expiry: longContract.expiry,
    kind: 'place_vertical_spread_order',
    longStrike: longContract.strike,
    optionType: longContract.optionType,
    priceEffect: 'Debit',
    shortStrike: parsed.legs[1]!.contract.strike,
    underlying: longContract.underlying,
  })
}
