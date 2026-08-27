import { QueryClient } from '@tanstack/query-core'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { createCollection } from '@tanstack/react-db'
import { z } from 'zod'

import {
  FavoriteMutationSchema,
  FavoriteSymbolsResponseSchema,
  type FavoriteMutation,
} from '../domain/favorites'
import { EquitySymbolSchema } from '../domain/instrument'
import { preferenceCollection, togglePinnedTicker, type Preference } from './collections'

const FAVORITE_REFRESH_INTERVAL_MS = 15_000
const FavoriteRowSchema = z.strictObject({ symbol: EquitySymbolSchema })

export function stagedFavoriteSymbols(preference: Preference | undefined): string[] {
  return preference?.favoriteUserId ? [] : [...(preference?.pinnedSymbols ?? [])]
}

async function requestFavoriteSymbols(
  mutation?: FavoriteMutation,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await fetch('/api/favorites', {
    method: mutation ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: mutation
      ? { Accept: 'application/json', 'Content-Type': 'application/json' }
      : { Accept: 'application/json' },
    body: mutation ? JSON.stringify(FavoriteMutationSchema.parse(mutation)) : undefined,
    signal,
  })
  if (!response.ok) throw new Error(`Favorite sync failed (${response.status})`)
  return FavoriteSymbolsResponseSchema.parse(await response.json()).symbols
}

async function markAnonymousStageConsumed(userId: string): Promise<void> {
  const current = preferenceCollection.get('primary')
  if (!current) return
  const mutation = preferenceCollection.update('primary', (draft) => {
    draft.favoriteUserId = userId
    draft.pinnedSymbols = []
  })
  await mutation.isPersisted.promise
}

function favoriteRows(symbols: readonly string[]) {
  return symbols.map((symbol) => FavoriteRowSchema.parse({ symbol }))
}

/**
 * One browser workspace owns one QueryClient. Keeping it out of module scope prevents
 * authenticated rows from ever being shared by Cloudflare SSR isolates.
 */
export function createFavoriteSync(userId: string) {
  const queryClient = new QueryClient()
  const queryKey = ['spice-favorites', userId] as const
  let anonymousStageConsumed = false
  let mutationTail: Promise<void> = Promise.resolve()

  const enqueueMutation = <T,>(task: () => Promise<T>): Promise<T> => {
    const execution = mutationTail.then(task)
    mutationTail = execution.then(() => undefined, () => undefined)
    return execution
  }

  const collection = createCollection(
    queryCollectionOptions({
      id: `spice-favorites-${userId}`,
      queryKey,
      queryClient,
      schema: FavoriteRowSchema,
      getKey: (favorite) => favorite.symbol,
      refetchInterval: FAVORITE_REFRESH_INTERVAL_MS,
      refetchOnMount: 'always',
      refetchOnReconnect: 'always',
      refetchOnWindowFocus: 'always',
      retry: 2,
      queryFn: async ({ signal }) => {
        if (anonymousStageConsumed) {
          return favoriteRows(await requestFavoriteSymbols(undefined, signal))
        }

        await preferenceCollection.preload()
        const preference = preferenceCollection.get('primary')
        const anonymousSymbols = stagedFavoriteSymbols(preference)
        const symbols = anonymousSymbols.length
          ? await requestFavoriteSymbols({ kind: 'merge', symbols: anonymousSymbols }, signal)
          : await requestFavoriteSymbols(undefined, signal)
        if (signal.aborted) throw new DOMException('Favorite sync was superseded', 'AbortError')
        await markAnonymousStageConsumed(userId)
        anonymousStageConsumed = true
        return favoriteRows(symbols)
      },
      onInsert: async ({ transaction }) => {
        const symbols = transaction.mutations.map((mutation) => mutation.modified.symbol)
        await enqueueMutation(() => requestFavoriteSymbols({ kind: 'merge', symbols }))
      },
      onDelete: async ({ transaction }) => {
        const symbols = transaction.mutations.map((mutation) => mutation.original.symbol)
        await enqueueMutation(() => requestFavoriteSymbols({ kind: 'remove', symbols }))
      },
    }),
  )

  return { collection }
}

export type FavoriteSync = ReturnType<typeof createFavoriteSync>

export async function toggleFavoriteSymbol(
  symbol: string,
  favoriteSync: FavoriteSync | undefined,
): Promise<void> {
  const parsed = EquitySymbolSchema.safeParse(symbol)
  if (!parsed.success) return
  if (!favoriteSync) return togglePinnedTicker(parsed.data)

  await favoriteSync.collection.preload()
  const transaction = favoriteSync.collection.get(parsed.data)
    ? favoriteSync.collection.delete(parsed.data)
    : favoriteSync.collection.insert({ symbol: parsed.data })
  await transaction.isPersisted.promise
}
