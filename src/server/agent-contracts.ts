import { z } from 'zod'

import { EquitySymbolSchema } from '../domain/instrument'
import { ISO_DATE_REGEX } from '../domain/iso-date'
import { OrderLegActionSchema } from '../domain/recommended-order'
import { zodTypeBoxSchema } from './zod-typebox'

import {
  AddWatchlistSymbolsSchema,
  RemoveWatchlistSymbolsSchema,
} from '../domain/watchlist'

const OrderIdSchema = z.string().regex(/^\d{1,40}$/)
const ExpiryDateSchema = z.string().regex(ISO_DATE_REGEX)
/** Limit prices are whole cents; the broker rejects finer increments. */
const LimitPriceSchema = z.number().positive().multipleOf(0.01)
// Quantity has no independent product ceiling. Fresh account state, contract
// multipliers, closing inventory, and the portfolio-loss budget decide what is safe.
const QuantitySchema = z.number().int().positive()

const OptionActionSchema = z.object({
  kind: z.literal('place_option_order'),
  underlying: EquitySymbolSchema,
  optionType: z.enum(['C', 'P']),
  strike: z.number().positive(),
  expiry: ExpiryDateSchema,
  action: OrderLegActionSchema,
  quantity: QuantitySchema,
  limitPrice: LimitPriceSchema,
  priceEffect: z.enum(['Debit', 'Credit']),
})

const EquityActionSchema = z.object({
  kind: z.literal('place_equity_order'),
  symbol: EquitySymbolSchema,
  action: OrderLegActionSchema,
  quantity: QuantitySchema,
  limitPrice: LimitPriceSchema,
  priceEffect: z.enum(['Debit', 'Credit']),
})

const VerticalSpreadActionSchema = z.object({
  kind: z.literal('place_vertical_spread_order'),
  underlying: EquitySymbolSchema,
  optionType: z.enum(['C', 'P']),
  expiry: ExpiryDateSchema,
  longStrike: z.number().positive(),
  shortStrike: z.number().positive(),
  quantity: QuantitySchema,
  limitPrice: LimitPriceSchema,
  priceEffect: z.literal('Debit'),
}).superRefine((action, context) => {
  const isDebitVertical = action.optionType === 'C'
    ? action.longStrike < action.shortStrike
    : action.longStrike > action.shortStrike
  if (!isDebitVertical) {
    context.addIssue({ code: 'custom', message: 'The long strike must define a debit vertical.', path: ['longStrike'] })
  }
  if (action.limitPrice >= Math.abs(action.shortStrike - action.longStrike)) {
    context.addIssue({ code: 'custom', message: 'The debit must be less than the spread width.', path: ['limitPrice'] })
  }
})

const ReplaceOrderActionSchema = z.object({
  kind: z.literal('replace_order'),
  orderId: OrderIdSchema,
  limitPrice: LimitPriceSchema,
})

/** Cancelling one working order: the broker's own order id and nothing else. */
export const CancelOrderSchema = z.strictObject({ orderId: OrderIdSchema })

export const CancelOrderParameters = zodTypeBoxSchema(CancelOrderSchema)

/**
 * A single-leg open or close must name the price effect its direction implies. Shared so the
 * fresh-order union and the full placement union enforce it identically.
 */
function requireDirectionalPriceEffect(
  action: { kind: string } & Partial<{ action: string; priceEffect: string }>,
  context: z.RefinementCtx,
): void {
  if (!action.action || !action.priceEffect) return
  // A vertical carries no single direction and a replacement changes only price, so neither
  // names an action or an effect to reconcile.
  const expectedEffect = action.action.startsWith('Buy') ? 'Debit' : 'Credit'
  if (action.priceEffect !== expectedEffect) {
    context.addIssue({
      code: 'custom',
      message: `${action.action} requires a ${expectedEffect.toLowerCase()}`,
      path: ['priceEffect'],
    })
  }
}

export const FreshOrderPlacementSchema = z.discriminatedUnion('kind', [
  OptionActionSchema,
  EquityActionSchema,
  VerticalSpreadActionSchema,
]).superRefine(requireDirectionalPriceEffect)

/**
 * One discriminated union of four, not a union of a union: nesting them made the advertised
 * JSON Schema an `anyOf` wrapping a `oneOf`, which is both larger on every request and harder
 * for a model to satisfy than a flat discriminated union keyed on `kind`.
 */
export const OrderPlacementSchema = z.discriminatedUnion('kind', [
  OptionActionSchema,
  EquityActionSchema,
  VerticalSpreadActionSchema,
  ReplaceOrderActionSchema,
]).superRefine(requireDirectionalPriceEffect)

/** The model and security boundary share one order contract; Zod refinements run again before storage. */
export const OrderPlacementParameters = zodTypeBoxSchema(OrderPlacementSchema)

export const StoredOrderPlacementSchema = z.union([
  FreshOrderPlacementSchema,
  ReplaceOrderActionSchema.extend({ replacementOrder: FreshOrderPlacementSchema }),
])

/**
 * Watchlist mutation only. Cancelling an order used to share this union, back when one chat
 * tool dispatched every direct account action; it is now its own tool with its own contract,
 * because the two need different authority — cancelling touches one member's account, while
 * removing a symbol changes what every reader sees.
 */
export const WatchlistActionSchema = z.discriminatedUnion('kind', [
  AddWatchlistSymbolsSchema,
  RemoveWatchlistSymbolsSchema,
])

export const WatchlistActionParameters = zodTypeBoxSchema(WatchlistActionSchema)

export type FreshOrderPlacement = z.infer<typeof FreshOrderPlacementSchema>
export type OrderPlacement = z.infer<typeof OrderPlacementSchema>
export type StoredOrderPlacement = z.infer<typeof StoredOrderPlacementSchema>
