import { z } from 'zod'

import { EquitySymbolSchema } from './instrument'
import { MAX_WATCHLIST_SYMBOLS } from './watchlist'

// Favorites are selected from the bounded market surface, so member storage uses
// the same cardinality instead of introducing a second product limit.
export const MAX_FAVORITE_SYMBOLS = MAX_WATCHLIST_SYMBOLS

export const FavoriteSymbolsSchema = z.array(EquitySymbolSchema).max(MAX_FAVORITE_SYMBOLS)

export const FavoriteMutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('merge'),
    symbols: FavoriteSymbolsSchema,
  }),
  z.strictObject({
    kind: z.literal('remove'),
    symbols: FavoriteSymbolsSchema.min(1),
  }),
])

export const FavoriteSymbolsResponseSchema = z.strictObject({
  symbols: FavoriteSymbolsSchema,
})

export type FavoriteMutation = z.infer<typeof FavoriteMutationSchema>
