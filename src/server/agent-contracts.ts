import { z } from 'zod'
import { Type } from 'typebox'

import { EquitySymbolSchema } from '../domain/instrument'
import { ISO_DATE_REGEX } from '../domain/iso-date'

import {
  AddWatchlistSymbolsSchema,
  RemoveWatchlistSymbolsSchema,
} from '../domain/watchlist'

const OrderActionSchema = z.enum(['Buy to Open', 'Sell to Open', 'Buy to Close', 'Sell to Close'])
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
  action: OrderActionSchema,
  quantity: QuantitySchema,
  limitPrice: LimitPriceSchema,
  priceEffect: z.enum(['Debit', 'Credit']),
})

const EquityActionSchema = z.object({
  kind: z.literal('place_equity_order'),
  symbol: EquitySymbolSchema,
  action: OrderActionSchema,
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

const CancelActionSchema = z.object({
  kind: z.literal('cancel_order'),
  orderId: OrderIdSchema,
})

export const FreshOrderPlacementSchema = z.discriminatedUnion('kind', [
  OptionActionSchema,
  EquityActionSchema,
  VerticalSpreadActionSchema,
])
  .superRefine((action, context) => {
    if (action.kind === 'place_vertical_spread_order') return
    const expectedEffect = action.action.startsWith('Buy') ? 'Debit' : 'Credit'
    if (action.priceEffect !== expectedEffect) {
      context.addIssue({
        code: 'custom',
        message: `${action.action} requires a ${expectedEffect.toLowerCase()}`,
        path: ['priceEffect'],
      })
    }
  })

export const OrderPlacementSchema = z.union([FreshOrderPlacementSchema, ReplaceOrderActionSchema])

function modelParameters<T extends z.ZodType>(schema: T) {
  const jsonSchema = { ...z.toJSONSchema(schema) }
  Reflect.deleteProperty(jsonSchema, '$schema')
  Reflect.deleteProperty(jsonSchema, '~standard')
  return Type.Unsafe<z.infer<T>>(jsonSchema)
}

/** The model and security boundary share one order contract; Zod refinements run again before storage. */
export const OrderPlacementParameters = modelParameters(OrderPlacementSchema)

export const StoredOrderPlacementSchema = z.union([
  FreshOrderPlacementSchema,
  ReplaceOrderActionSchema.extend({ replacementOrder: FreshOrderPlacementSchema }),
])

export const DirectAccountActionSchema = z.discriminatedUnion('kind', [
  CancelActionSchema,
  AddWatchlistSymbolsSchema,
  RemoveWatchlistSymbolsSchema,
])

/** Direct mutations use the same generated tool contract and server-side Zod boundary. */
export const DirectAccountActionParameters = modelParameters(DirectAccountActionSchema)

// These are request-envelope abuse bounds: chat is one model turn and the confirmation token is
// an opaque digest input, not domain data. They do not authorize or constrain trade size.
export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  selectedSymbol: EquitySymbolSchema.optional(),
})
export const ConfirmRequestSchema = z.object({
  decision: z.enum(['confirm', 'deny']),
  token: z.string().min(20).max(200),
})

export type FreshOrderPlacement = z.infer<typeof FreshOrderPlacementSchema>
export type OrderPlacement = z.infer<typeof OrderPlacementSchema>
export type StoredOrderPlacement = z.infer<typeof StoredOrderPlacementSchema>
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>

export function previewAction(action: OrderPlacement): string {
  if (action.kind === 'replace_order') return `Replace order #${action.orderId} @ $${action.limitPrice.toFixed(2)} limit`
  if (action.kind === 'place_equity_order') return `${action.action} ${action.quantity} ${action.symbol} @ $${action.limitPrice.toFixed(2)} limit`
  if (action.kind === 'place_vertical_spread_order') {
    return `Buy ${action.quantity} ${action.underlying} ${action.expiry} ${action.longStrike}/${action.shortStrike}${action.optionType} vertical @ $${action.limitPrice.toFixed(2)} debit`
  }
  return `${action.action} ${action.quantity} ${action.underlying} ${action.expiry} ${action.strike}${action.optionType} @ $${action.limitPrice.toFixed(2)} ${action.priceEffect.toLowerCase()}`
}
