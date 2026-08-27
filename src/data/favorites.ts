import {
  FavoriteMutationSchema,
  FavoriteSymbolsResponseSchema,
  FavoriteSymbolsSchema,
  type FavoriteMutation,
} from '../domain/favorites'
import { EquitySymbolSchema } from '../domain/instrument'
import { preferenceCollection, togglePinnedTicker, type Preference } from './collections'

function visibleFavoriteSymbols(preference: Preference | undefined, userId: string | undefined): string[] {
  if (!preference) return []
  if (!userId) return preference.favoriteUserId ? [] : preference.pinnedSymbols
  return preference.favoriteUserId && preference.favoriteUserId !== userId ? [] : preference.pinnedSymbols
}

export function favoriteSymbolsForViewer(
  preference: Preference | undefined,
  userId: string | undefined,
): string[] {
  return [...visibleFavoriteSymbols(preference, userId)]
}

async function replaceLocalFavorites(symbols: readonly string[], userId: string | undefined): Promise<void> {
  await preferenceCollection.preload()
  if (!preferenceCollection.get('primary')) return
  const parsed = FavoriteSymbolsSchema.parse(symbols)
  const mutation = preferenceCollection.update('primary', (draft) => {
    draft.pinnedSymbols = parsed
    if (userId) draft.favoriteUserId = userId
    else delete draft.favoriteUserId
  })
  await mutation.isPersisted.promise
}

async function requestFavorites(
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

// Browser requests and focus refreshes share one queue so a slower response cannot
// overwrite a newer explicit star/unstar result in the TanStack preference cache.
let favoriteTaskTail: Promise<void> = Promise.resolve()

function enqueueFavoriteTask(task: () => Promise<void>): Promise<void> {
  const execution = favoriteTaskTail.then(task)
  favoriteTaskTail = execution.catch(() => undefined)
  return execution
}

/**
 * A preference without a user id is anonymous staging. Its first authenticated sync
 * is additive; an account-scoped cache is refreshed instead, so stale devices cannot
 * re-add a symbol another signed-in device deliberately removed.
 */
async function syncFavoriteSymbolsImmediately(
  userId: string | undefined,
  signal?: AbortSignal,
): Promise<void> {
  await preferenceCollection.preload()
  const current = preferenceCollection.get('primary')
  if (!current) return
  if (!userId) {
    if (current.favoriteUserId) await replaceLocalFavorites([], undefined)
    return
  }
  const symbols = current.favoriteUserId === undefined
    ? await requestFavorites({ kind: 'merge', symbols: current.pinnedSymbols }, signal)
    : await requestFavorites(undefined, signal)
  if (!signal?.aborted) await replaceLocalFavorites(symbols, userId)
}

export function syncFavoriteSymbols(userId: string | undefined, signal?: AbortSignal): Promise<void> {
  return enqueueFavoriteTask(() => syncFavoriteSymbolsImmediately(userId, signal))
}

async function toggleFavoriteSymbolImmediately(symbol: string, userId: string | undefined): Promise<void> {
  const parsed = EquitySymbolSchema.safeParse(symbol)
  if (!parsed.success) return
  if (!userId) return togglePinnedTicker(parsed.data)

  await preferenceCollection.preload()
  let current = preferenceCollection.get('primary')
  if (!current) return
  if (current.favoriteUserId !== userId) {
    await syncFavoriteSymbolsImmediately(userId)
    current = preferenceCollection.get('primary')
  }
  if (!current || current.favoriteUserId !== userId) return
  const mutation: FavoriteMutation = current.pinnedSymbols.includes(parsed.data)
    ? { kind: 'remove', symbols: [parsed.data] }
    : { kind: 'merge', symbols: [parsed.data] }
  await replaceLocalFavorites(await requestFavorites(mutation), userId)
}

export function toggleFavoriteSymbol(symbol: string, userId: string | undefined): Promise<void> {
  return enqueueFavoriteTask(() => toggleFavoriteSymbolImmediately(symbol, userId))
}
