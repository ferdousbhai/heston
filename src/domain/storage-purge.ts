/**
 * The cookie that says a browser's storage for this origin has already been purged by the
 * current generation. Cookies are the one thing `Clear-Site-Data: "storage"` leaves behind,
 * which is what makes them the right receipt for it.
 */
export const STORAGE_PURGE_COOKIE = 'heston-storage-purge'

/** Bump to purge every browser once more; the comment on the purge says what that costs. */
export const STORAGE_PURGE_GENERATION = '1'

export function hasStoragePurge(
  cookieHeader: string | null,
  generation: string = STORAGE_PURGE_GENERATION,
): boolean {
  if (!cookieHeader) return false
  return cookieHeader.split(';').some((pair) => {
    const separator = pair.indexOf('=')
    if (separator === -1) return false
    return pair.slice(0, separator).trim() === STORAGE_PURGE_COOKIE
      && pair.slice(separator + 1).trim() === generation
  })
}
