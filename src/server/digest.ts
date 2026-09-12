/*
 * Base64url over raw bytes, and the SHA-256 of a string in that same alphabet.
 *
 * Shared because two unrelated boundaries derive an identifier exactly this way -- the stored
 * digest of an agent token, and the id an evidence card is upserted under. A second copy of
 * these few lines is a second definition of what those identifiers are, and the two would only
 * have to drift by a padding character for a stored row to stop matching what is recomputed.
 */

export function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

export async function sha256Base64Url(value: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
}
