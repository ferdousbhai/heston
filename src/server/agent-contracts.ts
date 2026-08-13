import { z } from 'zod'

export const OptionActionSchema = z.object({
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

export const EquityActionSchema = z.object({
  kind: z.literal('place_equity_order'),
  symbol: z.string().regex(/^[A-Z.]{1,8}$/),
  action: z.enum(['Buy to Open', 'Sell to Open', 'Buy to Close', 'Sell to Close']),
  quantity: z.number().int().min(1).max(10_000),
  limitPrice: z.number().positive().multipleOf(0.01),
  priceEffect: z.enum(['Debit', 'Credit']),
})

export const CancelActionSchema = z.object({
  kind: z.literal('cancel_order'),
  orderId: z.string().regex(/^\d{1,40}$/),
})

const WatchlistFields = {
  watchlistName: z.string().trim().min(1).max(64).refine((name) => !name.includes('/')),
  symbols: z.array(z.string().regex(/^[A-Z.]{1,8}$/)).min(1).max(50),
} as const

export const AddWatchlistActionSchema = z.object({ kind: z.literal('add_watchlist_symbols'), ...WatchlistFields })
export const RemoveWatchlistActionSchema = z.object({ kind: z.literal('remove_watchlist_symbols'), ...WatchlistFields })
export const DeleteWatchlistActionSchema = z.object({
  kind: z.literal('delete_watchlist'),
  watchlistName: WatchlistFields.watchlistName,
})

export const OrderPlacementSchema = z.discriminatedUnion('kind', [OptionActionSchema, EquityActionSchema])
  .superRefine((action, context) => {
    const expectedEffect = action.action.startsWith('Buy') ? 'Debit' : 'Credit'
    if (action.priceEffect !== expectedEffect) {
      context.addIssue({
        code: 'custom',
        message: `${action.action} requires a ${expectedEffect.toLowerCase()}`,
        path: ['priceEffect'],
      })
    }
  })

export const DirectAccountActionSchema = z.discriminatedUnion('kind', [
  CancelActionSchema,
  AddWatchlistActionSchema,
  RemoveWatchlistActionSchema,
  DeleteWatchlistActionSchema,
])

export const AgentPlanSchema = z.object({ message: z.string().min(1).max(2_000), action: OrderPlacementSchema.nullable() })
export const ChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(4_000),
  selectedSymbol: z.string().regex(/^[A-Z.]{1,8}$/).optional(),
})
export const ConfirmRequestSchema = z.object({
  decision: z.enum(['confirm', 'deny']),
  token: z.string().min(20).max(200),
})

export type DirectAccountAction = z.infer<typeof DirectAccountActionSchema>
export type OrderPlacement = z.infer<typeof OrderPlacementSchema>
export type ChatRequest = z.infer<typeof ChatRequestSchema>
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>

export function previewAction(action: OrderPlacement): string {
  if (action.kind === 'place_equity_order') return `${action.action} ${action.quantity} ${action.symbol} @ $${action.limitPrice.toFixed(2)} limit`
  return `${action.action} ${action.quantity} ${action.underlying} ${action.expiry} ${action.strike}${action.optionType} @ $${action.limitPrice.toFixed(2)} ${action.priceEffect.toLowerCase()}`
}
