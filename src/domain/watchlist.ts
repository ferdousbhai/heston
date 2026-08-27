import { z } from 'zod'

import { EquitySymbolSchema } from './instrument'

const WatchlistSymbolsSchema = z.array(EquitySymbolSchema).min(1).max(50)

/** Spice maintains one internal watchlist; broker list names are seed provenance, not mutation targets. */
export const AddWatchlistSymbolsSchema = z.strictObject({
  kind: z.literal('add_watchlist_symbols'),
  symbols: WatchlistSymbolsSchema,
})
export const RemoveWatchlistSymbolsSchema = z.strictObject({
  kind: z.literal('remove_watchlist_symbols'),
  symbols: WatchlistSymbolsSchema,
})
export const WatchlistMutationSchema = z.discriminatedUnion('kind', [
  AddWatchlistSymbolsSchema,
  RemoveWatchlistSymbolsSchema,
])

export type WatchlistMutation = z.infer<typeof WatchlistMutationSchema>

export const WatchlistMutationResultSchema = z.strictObject({
  appliedSymbols: z.array(EquitySymbolSchema).max(50),
  detail: z.string().min(1).max(500),
  discardedSymbols: z.array(EquitySymbolSchema).max(50),
})

export type WatchlistMutationResult = z.infer<typeof WatchlistMutationResultSchema>
