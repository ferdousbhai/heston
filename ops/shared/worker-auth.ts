type CloudflareSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView): boolean
}

/** Temporary ops Workers use a one-run bearer token and disclose no route on auth failure. */
export async function authorizedOpsRequest(request: Request, expected: string | undefined): Promise<boolean> {
  const provided = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1]
  if (!expected || !provided) return false
  const encoder = new TextEncoder()
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  // SAFETY: these temporary Workers run on Cloudflare, whose SubtleCrypto extension
  // provides constant-time comparison for equally sized SHA-256 digests.
  return (crypto.subtle as CloudflareSubtleCrypto).timingSafeEqual(providedHash, expectedHash)
}

