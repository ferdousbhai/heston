import { z } from 'zod'

import { EquitySymbolSchema } from './instrument'
import { ISO_DATE_REGEX, isValidIsoDate } from './iso-date'

/** Exact tastytrade leg actions; recommendation legs deliberately use only opening actions. */
export const OrderLegActionSchema = z.enum([
  'Buy to Open',
  'Sell to Open',
  'Buy to Close',
  'Sell to Close',
])

const ExpirySchema = z.string()
  .regex(ISO_DATE_REGEX)
  .refine(isValidIsoDate, 'Use a real YYYY-MM-DD date')

export const RecommendedOptionContractSchema = z.strictObject({
  expiry: ExpirySchema,
  optionType: z.enum(['C', 'P']),
  strike: z.number().positive(),
  underlying: EquitySymbolSchema,
})

const EquityLegSchema = z.strictObject({
  action: z.enum(['Buy to Open', 'Sell to Open']),
  instrumentType: z.literal('Equity'),
  symbol: EquitySymbolSchema,
})

const LongOptionLegSchema = z.strictObject({
  action: z.literal('Buy to Open'),
  contract: RecommendedOptionContractSchema,
  instrumentType: z.literal('Equity Option'),
})

const VerticalOptionLegSchema = z.strictObject({
  action: z.enum(['Buy to Open', 'Sell to Open']),
  contract: RecommendedOptionContractSchema,
  instrumentType: z.literal('Equity Option'),
})

/**
 * The model-authored, non-executable order shape. It keeps tastytrade's leg terminology but
 * omits account, provider option symbols, quantity, price, and time-in-force. Those values are
 * fresh execution state and may be added only through Dan's guarded OrderPlacement boundary.
 */
export const ActionableRecommendedOrderSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('equity'),
    legs: z.array(EquityLegSchema).length(1),
  }),
  z.strictObject({
    kind: z.literal('equity-option'),
    legs: z.array(LongOptionLegSchema).length(1),
  }),
  z.strictObject({
    kind: z.literal('equity-option-vertical'),
    legs: z.array(VerticalOptionLegSchema).length(2),
  }),
])

// The old archive retained only a display label, sometimes without a four-digit expiry.
// Keeping that degradation explicit avoids inventing a broker contract during migration.
const LegacyRecommendedOrderSchema = z.strictObject({
  kind: z.literal('legacy-unstructured'),
  label: z.string().min(1).max(200).nullable(),
})

export const RecommendedOrderSchema = z.union([
  ActionableRecommendedOrderSchema,
  LegacyRecommendedOrderSchema,
])

export type ActionableRecommendedOrder = z.infer<typeof ActionableRecommendedOrderSchema>
export type RecommendedOrder = z.infer<typeof RecommendedOrderSchema>
export type RecommendationDirection = 'bullish' | 'bearish' | 'neutral'

/** Cross-leg rules that JSON Schema cannot fully express to the research model. */
export function recommendedOrderIssues(
  order: ActionableRecommendedOrder,
  expectedSymbol: string,
  expectedDirection: RecommendationDirection,
): string[] {
  const issues: string[] = []
  if (expectedDirection === 'neutral') {
    issues.push('A neutral recommendation cannot carry a directional recommended order')
  }

  if (order.kind === 'equity') {
    const leg = order.legs[0]!
    if (leg.symbol !== expectedSymbol) issues.push('The equity leg must match the recommendation symbol')
    const direction = leg.action === 'Buy to Open' ? 'bullish' : 'bearish'
    if (direction !== expectedDirection) issues.push('The equity leg must match the recommendation direction')
    return issues
  }

  const [longLeg, shortLeg] = order.legs
  const contract = longLeg!.contract
  if (order.legs.some((leg) => leg.contract.underlying !== expectedSymbol)) {
    issues.push('Every option leg must match the recommendation symbol')
  }
  const direction = contract.optionType === 'C' ? 'bullish' : 'bearish'
  if (direction !== expectedDirection) issues.push('The option type must match the recommendation direction')
  if (order.kind === 'equity-option') return issues

  if (longLeg!.action !== 'Buy to Open' || shortLeg!.action !== 'Sell to Open') {
    issues.push('A debit vertical must list its bought leg before its sold leg')
  }
  if (shortLeg!.contract.expiry !== contract.expiry
    || shortLeg!.contract.optionType !== contract.optionType
    || shortLeg!.contract.underlying !== contract.underlying) {
    issues.push('Both vertical legs must share an underlying, expiry, and option type')
  }
  const debitOrder = contract.optionType === 'C'
    ? contract.strike < shortLeg!.contract.strike
    : contract.strike > shortLeg!.contract.strike
  if (!debitOrder) issues.push('The long strike must define a debit vertical')
  return issues
}

/** Compact, unambiguous reader rendering of the validated order terms. */
export function recommendedOrderLabel(order: RecommendedOrder): string {
  if (order.kind === 'legacy-unstructured') {
    return order.label
      ? `Legacy terms · ${order.label}`
      : 'Legacy terms unavailable'
  }
  if (order.kind === 'equity') {
    const leg = order.legs[0]!
    return `${leg.action} ${leg.symbol} shares`
  }
  const longLeg = order.legs[0]!
  const contract = longLeg.contract
  if (order.kind === 'equity-option') {
    return `${longLeg.action} ${contract.underlying} ${contract.strike}${contract.optionType} · ${contract.expiry}`
  }
  const shortContract = order.legs[1]!.contract
  return `${contract.underlying} ${contract.strike}/${shortContract.strike}${contract.optionType} debit vertical · ${contract.expiry}`
}
