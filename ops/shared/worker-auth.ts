import { type AppEnv } from '../../src/server/env'

type CloudflareSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView): boolean
}

export type OpsEnv = AppEnv & { OPS_AUTH_TOKEN?: string }

// This repository's error codes are a PascalCase identifier, optionally followed by
// `:`-joined segments of letters, digits, `_`, `.`, or `-` (e.g.
// 'InternalWatchlist:too-many-entries:123', 'TastytradeAuth:401'). A message outside
// that shape is prose meant for a stack trace, not a code a caller should parse, and
// may carry provider or request detail that must not leave the boundary.
const OPS_FAILURE_CODE = /^[A-Za-z][A-Za-z0-9]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/

async function authorizedOpsRequest(request: Request, expected: string | undefined): Promise<boolean> {
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

/**
 * The single request gate for every temporary ops Worker. A non-POST method, an
 * unlisted path, and a failed bearer check are answered identically with a bare
 * 404 — never 401 or 403, and never a body naming the route — so an unauthorized
 * caller cannot learn that these owner-only bootstrap endpoints exist at all.
 * Only a caller that already proved the token can observe a handler's failure,
 * and that failure reports a stable code rather than an unbounded cause.
 */
export async function serveOpsRequest(
  request: Request,
  env: OpsEnv,
  paths: readonly string[],
  failureCode: string,
  handle: (path: string) => Promise<Response>,
): Promise<Response> {
  const path = new URL(request.url).pathname
  if (request.method !== 'POST'
    || !paths.includes(path)
    || !await authorizedOpsRequest(request, env.OPS_AUTH_TOKEN)) {
    return new Response('Not found', { status: 404 })
  }
  try {
    return await handle(path)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : undefined
    const code = message !== undefined && OPS_FAILURE_CODE.test(message) ? message : failureCode
    return Response.json({ error: code }, { status: 500 })
  }
}
