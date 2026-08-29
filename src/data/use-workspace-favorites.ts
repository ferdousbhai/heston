import { useCallback, useMemo, useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'

import { toError } from '../domain/failure'
import { type Preference } from './collections'
import {
  createFavoriteSync,
  favoriteStageMarkerCollection,
  stagedFavoriteSymbols,
  toggleFavoriteSymbol,
} from './favorites'

export function useWorkspaceFavorites(viewerId: string | undefined, preference: Preference | undefined) {
  const favoriteSync = useMemo(
    () => viewerId ? createFavoriteSync(viewerId) : undefined,
    [viewerId],
  )
  const stageQuery = useLiveQuery(
    (query) => query.from({ favoriteStageMarker: favoriteStageMarkerCollection }),
  )
  const favoriteQuery = useLiveQuery(
    () => favoriteSync?.collection,
    [favoriteSync],
  )
  const [mutationError, setMutationError] = useState<string>()
  const stageMarker = (stageQuery.data ?? [])[0]
  const pinnedSymbols = favoriteSync
    ? (favoriteQuery.data ?? []).map((favorite) => favorite.symbol)
    : stagedFavoriteSymbols(preference, stageMarker)
  const error = favoriteSync && favoriteQuery.isError
    ? 'Favorite synchronization failed.'
    : mutationError

  const togglePinned = useCallback((symbol: string) => {
    setMutationError(undefined)
    void toggleFavoriteSymbol(symbol, favoriteSync).catch((cause: unknown) => {
      setMutationError(toError(cause)?.message ?? 'The favorite could not be updated')
    })
  }, [favoriteSync])

  return {
    collectionFailed: stageQuery.isError,
    error,
    pinnedSymbols,
    togglePinned,
  }
}
