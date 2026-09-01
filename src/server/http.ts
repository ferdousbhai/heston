import { type JsonValue } from '../domain/json-payload'
import { toError } from '../domain/failure'
import { SPICE_DEPLOYMENT_ID } from '../deployment'
import { SPICE_DEPLOYMENT_ID_HEADER } from '../domain/deployment'
import {
  getAuthenticatedIdentity,
  isOwnerEmail,
  type AuthenticatedIdentity,
} from './auth'
import { type AppEnv } from './env'
import { OwnerVisibleError } from './owner-visible-error'

const CANONICAL_ORIGIN = 'https://tryspice.xyz'
const NON_CANONICAL_HOSTS = new Set(['www.tryspice.xyz'])
export const PUBLIC_RESPONSE_CACHE_CONTROL = 'public, max-age=30, s-maxage=60'

export function canonicalHostRedirect(request: Request): Response | undefined {
  const url = new URL(request.url)
  if (!NON_CANONICAL_HOSTS.has(url.hostname)) return undefined
  return Response.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 308)
}

export function jsonNoStore(value: JsonValue, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'no-store')
  headers.set(SPICE_DEPLOYMENT_ID_HEADER, SPICE_DEPLOYMENT_ID)
  return Response.json(value, { ...init, headers })
}

/** Public, account-free market data. Shared caches may retain it briefly to protect broker limits. */
export function jsonPublic(value: JsonValue, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', PUBLIC_RESPONSE_CACHE_CONTROL)
  headers.set(SPICE_DEPLOYMENT_ID_HEADER, SPICE_DEPLOYMENT_ID)
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

/** Every account, agent, operations, live-stream, and trading route stays exact-owner only. */
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

type OwnerHttpFailureStatus = 409 | 502

export type OwnerHttpFailure = {
  message: string
  status: OwnerHttpFailureStatus
}

const SAFE_OWNER_ERROR_MESSAGES = new Map([
  ['InternalWatchlist:not-seeded', 'The internal watchlist has not been initialized'],
  ['InternalWatchlist:not-finalized', 'The internal watchlist is still being initialized'],
])

/** Map private route failures through an explicit display allowlist and redact everything else. */
export function ownerHttpFailure(
  error: Error | undefined,
  fallbackStatus: OwnerHttpFailureStatus,
): OwnerHttpFailure {
  if (!error) return { message: 'The request could not be completed', status: fallbackStatus }
  if (error instanceof OwnerVisibleError) {
    return {
      message: error.message,
      status: error.kind === 'ambiguous-brokerage' ? 502 : fallbackStatus,
    }
  }
  const safeMessage = SAFE_OWNER_ERROR_MESSAGES.get(error.message)
  if (safeMessage) return { message: safeMessage, status: fallbackStatus }
  return { message: 'The request could not be completed', status: fallbackStatus }
}
