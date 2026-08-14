import { z } from 'zod'

export const WatchlistNameSchema = z.string().trim().min(1).max(64)
  .refine((name) => !name.includes('/'))
export const WatchlistSymbolsSchema = z.array(z.string().regex(/^[A-Z.]{1,8}$/)).min(1).max(50)

export const AddWatchlistSymbolsSchema = z.object({
  kind: z.literal('add_watchlist_symbols'),
  watchlistName: WatchlistNameSchema,
  symbols: WatchlistSymbolsSchema,
})
export const RemoveWatchlistSymbolsSchema = z.object({
  kind: z.literal('remove_watchlist_symbols'),
  watchlistName: WatchlistNameSchema,
  symbols: WatchlistSymbolsSchema,
})
export const WatchlistMutationSchema = z.discriminatedUnion('kind', [
  AddWatchlistSymbolsSchema,
  RemoveWatchlistSymbolsSchema,
])

export type WatchlistMutation = z.infer<typeof WatchlistMutationSchema>

export const AggregateWatchlistMutationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add_watchlist_symbols'), symbols: WatchlistSymbolsSchema }),
  z.object({ kind: z.literal('remove_watchlist_symbols'), symbols: WatchlistSymbolsSchema }),
])

export type AggregateWatchlistMutation = z.infer<typeof AggregateWatchlistMutationSchema>
