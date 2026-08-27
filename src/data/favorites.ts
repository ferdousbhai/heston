import { QueryClient } from '@tanstack/query-core'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { createCollection, localStorageCollectionOptions } from '@tanstack/react-db'
import { z } from 'zod'

import {
  FavoriteMutationSchema,
  FavoriteSymbolsResponseSchema,
  type FavoriteMutation,
} from '../domain/favorites'
import { EquitySymbolSchema } from '../domain/instrument'
import { MAX_LIVE_MARKET_SYMBOLS, preferenceCollection, type Preference } from './collections'

const FAVORITE_REFRESH_INTERVAL_MS = 15_000
const FavoriteRowSchema = z.strictObject({ symbol: EquitySymbolSchema })
const FavoriteStageMarkerSchema = z.strictObject({
  consumedStageId: z.string().max(4_096),
  id: z.literal('primary'),
})

export type FavoriteStageMarker = z.infer<typeof FavoriteStageMarkerSchema>

// Consumption lives under its own storage key. An authenticated response can
// therefore mark only the stage it sent without overwriting a newer preference
// row written by another tab while that request was in flight.
export const favoriteStageMarkerCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-favorite-stage-markers',
    storageKey: 'spice.favorite-stage.v1',
    schema: FavoriteStageMarkerSchema,
    getKey: (marker) => marker.id,
    startSync: true,
  }),
)

type AnonymousFavoriteStage = {
  id: string
  symbols: string[]
}

function anonymousFavoriteStage(preference: Preference | undefined): AnonymousFavoriteStage | undefined {
  if (!preference) return
  const symbols = [...preference.pinnedSymbols]
  if (preference.favoriteStageVersion) {
    return { id: `version:${preference.favoriteStageVersion}`, symbols }
  }
  if (preference.favoriteUserId) return
  return { id: `legacy:${JSON.stringify([...symbols].sort())}`, symbols }
}

export function stagedFavoriteSymbols(
  preference: Preference | undefined,
  marker?: FavoriteStageMarker,
): string[] {
  const stage = anonymousFavoriteStage(preference)
  return stage && stage.id !== marker?.consumedStageId ? stage.symbols : []
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

async function markAnonymousStageConsumed(stageId: string): Promise<void> {
  const current = favoriteStageMarkerCollection.get('primary')
  if (current?.consumedStageId === stageId) return
  const mutation = current
    ? favoriteStageMarkerCollection.update('primary', (draft) => {
        draft.consumedStageId = stageId
      })
    : favoriteStageMarkerCollection.insert({ consumedStageId: stageId, id: 'primary' })
  await mutation.isPersisted.promise
}

async function toggleAnonymousFavorite(symbol: string): Promise<void> {
  await Promise.all([
    preferenceCollection.preload(),
    favoriteStageMarkerCollection.preload(),
  ])
  const current = preferenceCollection.get('primary')
  if (!current) return
  const marker = favoriteStageMarkerCollection.get('primary')
  const pinnedSymbols = stagedFavoriteSymbols(current, marker)
  const nextSymbols = pinnedSymbols.includes(symbol)
    ? pinnedSymbols.filter((candidate) => candidate !== symbol)
    : [...pinnedSymbols, symbol].slice(-MAX_LIVE_MARKET_SYMBOLS)
  const mutation = preferenceCollection.update('primary', (draft) => {
    draft.favoriteStageVersion = crypto.randomUUID()
    delete draft.favoriteUserId
    draft.pinnedSymbols = nextSymbols
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
        await Promise.all([
          preferenceCollection.preload(),
          favoriteStageMarkerCollection.preload(),
        ])
        const preference = preferenceCollection.get('primary')
        const stage = anonymousFavoriteStage(preference)
        const marker = favoriteStageMarkerCollection.get('primary')
        const pendingStage = stage?.id === marker?.consumedStageId ? undefined : stage
        const symbols = pendingStage?.symbols.length
          ? await requestFavoriteSymbols({ kind: 'merge', symbols: pendingStage.symbols }, signal)
          : await requestFavoriteSymbols(undefined, signal)
        if (signal.aborted) throw new DOMException('Favorite sync was superseded', 'AbortError')
        if (pendingStage) await markAnonymousStageConsumed(pendingStage.id)
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
  if (!favoriteSync) return toggleAnonymousFavorite(parsed.data)

  await favoriteSync.collection.preload()
  const transaction = favoriteSync.collection.get(parsed.data)
    ? favoriteSync.collection.delete(parsed.data)
    : favoriteSync.collection.insert({ symbol: parsed.data })
  await transaction.isPersisted.promise
}
