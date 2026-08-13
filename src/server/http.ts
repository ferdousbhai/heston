import { getOwnerSession } from './auth'
import { type AppEnv } from './env'

export function jsonNoStore(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'no-store')
  return Response.json(value, { ...init, headers })
}

export async function authorizePersonalRequest(request: Request, env: AppEnv, write = false): Promise<Response | undefined> {
  if (env.APP_MODE !== 'live') return undefined
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
  return 'The request could not be completed'
}
