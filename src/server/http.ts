import { getOwnerSession } from './auth'
import { type AppEnv } from './env'

const CANONICAL_ORIGIN = 'https://tryspice.xyz'
const NON_CANONICAL_HOSTS = new Set(['www.tryspice.xyz'])

export function canonicalHostRedirect(request: Request): Response | undefined {
  const url = new URL(request.url)
  if (!NON_CANONICAL_HOSTS.has(url.hostname)) return undefined
  return Response.redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`, 308)
}

export function jsonNoStore(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'no-store')
  return Response.json(value, { ...init, headers })
}

export async function authorizePersonalRequest(request: Request, env: AppEnv, write = false): Promise<Response | undefined> {
  try {
    if (!await getOwnerSession(request, env)) {
      return jsonNoStore({ error: 'Authentication required' }, { status: 401 })
    }
  } catch {
    return jsonNoStore({ error: 'Authentication is not configured' }, { status: 503 })
  }
  if (write) {
    const origin = request.headers.get('Origin')
    if (!origin || origin !== new URL(request.url).origin) {
      return jsonNoStore({ error: 'Cross-origin request rejected' }, { status: 403 })
    }
  }
  return undefined
}

export function publicError(error: unknown): string {
  if (!(error instanceof Error)) return 'Request failed'
  if (error.message.includes('expired')) return 'This confirmation has expired'
  if (error.message.includes('no longer pending') || error.message.includes('already resolved')) {
    return 'This action is no longer pending'
  }
  if (error.message.includes('contract is not available')) return error.message
  if (error.name === 'PortfolioRiskError') return error.message
  if (error.name === 'BrokerageSubmissionUnknownError') return error.message
  if (error.name === 'TastytradeOrderWarningError') return error.message
  if (error.message.includes('WatchlistMutation:not-found')) return 'No private watchlist is available to update'
  return 'The request could not be completed'
}
