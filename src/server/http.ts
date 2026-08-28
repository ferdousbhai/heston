import { type JsonValue } from '../domain/json-payload'
import {
  getAuthenticatedIdentity,
  isOwnerEmail,
  type AuthenticatedIdentity,
} from './auth'
import { type AppEnv } from './env'

const CANONICAL_ORIGIN = 'https://tryspice.xyz'
const NON_CANONICAL_HOSTS = new Set(['www.tryspice.xyz'])

export function canonicalHostRedirect(request: Request): Response | undefined {
  const url = new URL(request.url)
  if (!NON_CANONICAL_HOSTS.has(url.hostname)) return undefined
  return Response.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 308)
}

export function jsonNoStore(value: JsonValue, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'no-store')
  return Response.json(value, { ...init, headers })
}

/** Public, account-free market data. Shared caches may retain it briefly to protect broker limits. */
export function jsonPublic(value: JsonValue, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'public, max-age=30, s-maxage=60, stale-while-revalidate=120')
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
  } catch {
    return { response: jsonNoStore({ error: 'Authentication is not configured' }, { status: 503 }) }
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

export function publicError(error: Error | undefined): string {
  if (!error) return 'Request failed'
  if (error.message.includes('expired')) return 'This confirmation has expired'
  if (error.message.includes('no longer pending') || error.message.includes('already resolved')) {
    return 'This action is no longer pending'
  }
  if (error.message.includes('contract is not available')) return error.message
  if (error.name === 'PortfolioRiskError') return error.message
  if (error.name === 'BrokerageSubmissionUnknownError') return error.message
  if (error.name === 'TastytradeOrderWarningError') return error.message
  if (error.message.includes('InternalWatchlist:not-seeded')) return 'The internal watchlist has not been initialized'
  if (error.message.includes('InternalWatchlist:not-finalized')) return 'The internal watchlist is still being initialized'
  return 'The request could not be completed'
}
