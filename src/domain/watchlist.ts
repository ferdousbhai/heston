import { z } from 'zod'

const WatchlistSymbolsSchema = z.array(z.string().regex(/^[A-Z][A-Z.]{0,7}$/)).min(1).max(50)

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
