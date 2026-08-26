import { z } from 'zod'

import {
  AddWatchlistSymbolsSchema,
  RemoveWatchlistSymbolsSchema,
} from '../domain/watchlist'

const OptionActionSchema = z.object({
  kind: z.literal('place_option_order'),
  underlying: z.string().regex(/^[A-Z.]{1,8}$/),
  optionType: z.enum(['C', 'P']),
  strike: z.number().positive(),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  action: z.enum(['Buy to Open', 'Sell to Open', 'Buy to Close', 'Sell to Close']),
  quantity: z.number().int().min(1).max(100),
  limitPrice: z.number().positive().multipleOf(0.01),
  priceEffect: z.enum(['Debit', 'Credit']),
})

const EquityActionSchema = z.object({
  kind: z.literal('place_equity_order'),
  symbol: z.string().regex(/^[A-Z.]{1,8}$/),
  action: z.enum(['Buy to Open', 'Sell to Open', 'Buy to Close', 'Sell to Close']),
  quantity: z.number().int().min(1).max(10_000),
  limitPrice: z.number().positive().multipleOf(0.01),
  priceEffect: z.enum(['Debit', 'Credit']),
})

const VerticalSpreadActionSchema = z.object({
  kind: z.literal('place_vertical_spread_order'),
  underlying: z.string().regex(/^[A-Z.]{1,8}$/),
  optionType: z.enum(['C', 'P']),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  longStrike: z.number().positive(),
  shortStrike: z.number().positive(),
  quantity: z.number().int().min(1).max(100),
  limitPrice: z.number().positive().multipleOf(0.01),
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
  orderId: z.string().regex(/^\d{1,40}$/),
  limitPrice: z.number().positive().multipleOf(0.01),
})

const CancelActionSchema = z.object({
  kind: z.literal('cancel_order'),
  orderId: z.string().regex(/^\d{1,40}$/),
})

const AddWatchlistActionSchema = AddWatchlistSymbolsSchema
const RemoveWatchlistActionSchema = RemoveWatchlistSymbolsSchema

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

export const StoredOrderPlacementSchema = z.union([
  FreshOrderPlacementSchema,
  ReplaceOrderActionSchema.extend({ replacementOrder: FreshOrderPlacementSchema }),
])

export const DirectAccountActionSchema = z.discriminatedUnion('kind', [
  CancelActionSchema,
  AddWatchlistActionSchema,
  RemoveWatchlistActionSchema,
])

export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  selectedSymbol: z.string().regex(/^[A-Z.]{1,8}$/).optional(),
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
