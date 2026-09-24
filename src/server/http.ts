import { type JsonValue } from '../domain/json-payload'
import { toError } from '../domain/failure'
import { HESTON_DEPLOYMENT_ID } from '../deployment'
import { HESTON_DEPLOYMENT_ID_HEADER, PUBLIC_RESPONSE_MAX_AGE_SECONDS } from '../domain/deployment'
import { hasStoragePurge, STORAGE_PURGE_COOKIE, STORAGE_PURGE_GENERATION } from '../domain/storage-purge'
import {
  getAuthenticatedIdentity,
  isOwnerEmail,
  type AuthenticatedIdentity,
} from './auth'
import { type AppEnv } from './env'

const CANONICAL_ORIGIN = 'https://heston.io'
/**
 * `www` plus the retired tryspice.xyz brand, whose zone still routes here so its links keep
 * resolving. 308 preserves method and body, so a page load and a form POST both survive the hop.
 */
const NON_CANONICAL_HOSTS = new Set(['www.heston.io', 'tryspice.xyz', 'www.tryspice.xyz'])
/**
 * The MCP endpoint on an old host is refused rather than redirected. A cross-origin redirect
 * drops `Authorization`, and `/mcp` serves a header-less request as the anonymous caller, so a
 * member's agent following the 308 would silently lose its account tools instead of failing.
 * An error naming the canonical endpoint is what tells the member to re-point the config.
 */
const MCP_PATH = '/mcp'
export const PUBLIC_RESPONSE_CACHE_CONTROL = `public, max-age=${PUBLIC_RESPONSE_MAX_AGE_SECONDS}, s-maxage=60`
/**
 * An archived page is keyed by a market date and answered with the brief for the latest date
 * before it, which changes only when that date is republished or a missing date in between is
 * first published late, so it may be kept for an hour by a browser and a day at the edge.
 */
export const ARCHIVE_RESPONSE_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400'

export function canonicalHostRedirect(request: Request): Response | undefined {
  const url = new URL(request.url)
  if (!NON_CANONICAL_HOSTS.has(url.hostname)) return undefined
  if (url.pathname === MCP_PATH) {
    const endpoint = `${CANONICAL_ORIGIN}${MCP_PATH}`
    return Response.json({
      error: {
        code: -32_600,
        message: `Heston's MCP endpoint is ${endpoint} — this host no longer serves it. Reconnect to ${endpoint}.`,
      },
      id: null,
      jsonrpc: '2.0',
    }, { headers: { 'Cache-Control': 'no-store' }, status: 404 })
  }
  return Response.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 308)
}

export function jsonNoStore(value: JsonValue, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'no-store')
  headers.set(HESTON_DEPLOYMENT_ID_HEADER, HESTON_DEPLOYMENT_ID)
  return Response.json(value, { ...init, headers })
}

/** Owner snapshot: never CDN-cached, but ETag lets a sitting tab 304 instead of re-downloading. */
export function jsonPrivateRevalidate(request: Request, value: JsonValue, etag: string): Response {
  const headers = new Headers()
  headers.set('Cache-Control', 'private, no-cache')
  headers.set('ETag', etag)
  headers.set(HESTON_DEPLOYMENT_ID_HEADER, HESTON_DEPLOYMENT_ID)
  const tags = (request.headers.get('If-None-Match') ?? '').split(',').map((part) => part.trim())
  if (tags.includes(etag) || tags.includes('*')) return new Response(null, { headers, status: 304 })
  return Response.json(value, { headers })
}

/**
 * A year: the receipt should outlive any tab, and a browser that returns after longer than
 * that has earned a second purge over keeping whatever it still holds.
 */
const STORAGE_PURGE_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60

/**
 * The document response, with the headers only the Worker can add.
 *
 * The shell names the hashed bundles for one deployment, so a cached copy pins a browser to
 * code that no longer exists. It carries no validators either, so a revalidating fetch is a
 * plain refetch of a small document. Hashed assets stay immutable via `_headers`.
 *
 * Once per browser, the document also asks the browser itself to drop everything it stores
 * for this origin. An obsolete service worker held phones on a dead build, and page code could
 * not retire it: on WebKit the worker stalled the very module that would have run the fix, and
 * the registration API the inline guard falls back on hung with it. `Clear-Site-Data` is
 * processed by the browser's network layer before the document commits, so it needs nothing
 * of ours to run. "storage" unregisters service workers and empties the Cache API along with
 * localStorage, sessionStorage, and IndexedDB; "cache" drops the HTTP cache too, so the next
 * load is entirely current. The price is one cold start per browser per generation: the saved
 * market re-syncs, the selected ticker resets, and favorites a visitor staged without signing
 * in are gone — they are the only state that lives nowhere else. Cookies survive, so the owner
 * stays signed in and the receipt below is what stops the purge repeating. A fetch made without
 * credentials never carries the receipt and is purged again on purpose: that is how the old
 * worker refreshed its shell, and a purge it triggers itself is the best outcome available.
 * The guard clears the receipt before its own reload for the same reason.
 */
export function finalizeDocumentResponse(request: Request, response: Response): Response {
  if (!response.headers.get('content-type')?.includes('text/html')) return response
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-cache')
  headers.set(HESTON_DEPLOYMENT_ID_HEADER, HESTON_DEPLOYMENT_ID)
  if (!hasStoragePurge(request.headers.get('cookie'))) {
    headers.set('Clear-Site-Data', '"cache", "storage"')
    // Readable by the inline guard, which drops it before reloading; Secure only where the
    // browser would refuse it otherwise, so the local dev server exercises the same path.
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
    headers.append('Set-Cookie', `${STORAGE_PURGE_COOKIE}=${STORAGE_PURGE_GENERATION}; Max-Age=${STORAGE_PURGE_COOKIE_MAX_AGE_S}; Path=/; SameSite=Lax${secure}`)
  }
  return new Response(response.body, { headers, status: response.status, statusText: response.statusText })
}

/** Public, account-free market data. Shared caches may retain it briefly to protect broker limits. */
export function jsonPublic(value: JsonValue, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', PUBLIC_RESPONSE_CACHE_CONTROL)
  headers.set(HESTON_DEPLOYMENT_ID_HEADER, HESTON_DEPLOYMENT_ID)
  return Response.json(value, { ...init, headers })
}

type IdentityReader = (request: Request, env: AppEnv) => Promise<AuthenticatedIdentity | null>
type AuthenticationResult = { identity: AuthenticatedIdentity } | { response: Response }

export async function authenticateRequest(
  request: Request,
  env: AppEnv,
  write = false,
  readIdentity: IdentityReader = getAuthenticatedIdentity,
): Promise<AuthenticationResult> {
  let identity: AuthenticatedIdentity | null
  try {
    identity = await readIdentity(request, env)
  } catch (cause) {
    console.error('AuthenticationUnavailable', toError(cause)?.name ?? 'UnknownError')
    return { response: jsonNoStore({ error: 'Authentication is temporarily unavailable' }, { status: 503 }) }
  }
  if (!identity) return { response: jsonNoStore({ error: 'Authentication required' }, { status: 401 }) }
  if (write) {
    const origin = request.headers.get('Origin')
    if (!origin || origin !== new URL(request.url).origin) {
      return { response: jsonNoStore({ error: 'Cross-origin request rejected' }, { status: 403 }) }
    }
  }
  return { identity }
}

/**
 * The owner-only gate for a cookie-authenticated route: a signed-in identity whose email is the
 * owner's, and for a `write` the request's own origin as well. It guards the owner's market
 * snapshot (`/api/snapshot`, whose `?live=1` rebuilds from the broker on this Worker's own
 * credential) and the owner's forced catalyst refresh, which spends a paid search the
 * reader-attention window would have refused.
 */
export async function authorizePersonalRequest(
  request: Request,
  env: AppEnv,
  write = false,
  readIdentity: IdentityReader = getAuthenticatedIdentity,
): Promise<Response | undefined> {
  const authenticated = await authenticateRequest(request, env, write, readIdentity)
  if ('response' in authenticated) return authenticated.response
  if (!isOwnerEmail(authenticated.identity.email)) {
    return jsonNoStore({ error: 'Owner access required' }, { status: 403 })
  }
  return undefined
}
