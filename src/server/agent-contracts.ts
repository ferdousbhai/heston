import { z } from 'zod'

const OptionActionSchema = z.object({
  kind: z.literal('place_option_order'),
  underlying: z.string().regex(/^[A-Z.]{1,8}$/),
  optionType: z.enum(['C', 'P']),
  strike: z.number().positive(),
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  action: z.enum(['Buy to Open', 'Sell to Open', 'Buy to Close', 'Sell to Close']),
  quantity: z.number().int().min(1).max(100),
  limitPrice: z.number().positive(),
  priceEffect: z.enum(['Debit', 'Credit']),
})

const EquityActionSchema = z.object({
  kind: z.literal('place_equity_order'),
  symbol: z.string().regex(/^[A-Z.]{1,8}$/),
  action: z.enum(['Buy to Open', 'Sell to Open', 'Buy to Close', 'Sell to Close']),
  quantity: z.number().int().min(1).max(10_000),
  limitPrice: z.number().positive(),
  priceEffect: z.enum(['Debit', 'Credit']),
})

const CancelActionSchema = z.object({
  kind: z.literal('cancel_order'),
  orderId: z.string().regex(/^\d{1,40}$/),
})

export const BrokerageActionSchema = z.discriminatedUnion('kind', [OptionActionSchema, EquityActionSchema, CancelActionSchema])
export const AgentPlanSchema = z.object({ message: z.string().min(1).max(2_000), action: BrokerageActionSchema.nullable() })
export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  selectedSymbol: z.string().regex(/^[A-Z.]{1,8}$/).optional(),
})
export const ConfirmRequestSchema = z.object({
  decision: z.enum(['confirm', 'deny']),
  token: z.string().min(20).max(200),
})

export type BrokerageAction = z.infer<typeof BrokerageActionSchema>
export type ChatRequest = z.infer<typeof ChatRequestSchema>
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>

export function previewAction(action: BrokerageAction): string {
  if (action.kind === 'cancel_order') return `Cancel working order #${action.orderId}`
  if (action.kind === 'place_equity_order') return `${action.action} ${action.quantity} ${action.symbol} @ $${action.limitPrice.toFixed(2)} limit`
  return `${action.action} ${action.quantity} ${action.underlying} ${action.expiry} ${action.strike}${action.optionType} @ $${action.limitPrice.toFixed(2)} ${action.priceEffect.toLowerCase()}`
}
