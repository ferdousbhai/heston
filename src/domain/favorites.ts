import { z } from 'zod'

import { EquitySymbolSchema } from './instrument'

export const MAX_FAVORITE_SYMBOLS = 100

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
