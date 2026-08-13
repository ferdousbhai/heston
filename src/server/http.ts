import { createRemoteJWKSet, jwtVerify } from 'jose'

import { type AppEnv } from './env'
import { readSecret } from './secrets'

let cachedKeySet: { domain: string; value: ReturnType<typeof createRemoteJWKSet> } | undefined

export function jsonNoStore(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers)
  headers.set('Cache-Control', 'no-store')
  return Response.json(value, { ...init, headers })
}

function accessKeySet(teamDomain: string) {
  if (cachedKeySet?.domain === teamDomain) return cachedKeySet.value
  const value = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', `${teamDomain}/`))
  cachedKeySet = { domain: teamDomain, value }
  return value
}

async function accessConfig(env: AppEnv) {
  if (!env.CF_ACCESS_TEAM_DOMAIN || !env.CF_ACCESS_AUD || !env.CF_ACCESS_ALLOWED_EMAIL) return undefined
  try {
    const [teamDomain, audience, allowedEmail] = await Promise.all([
      readSecret(env.CF_ACCESS_TEAM_DOMAIN, 'CF_ACCESS_TEAM_DOMAIN'),
      readSecret(env.CF_ACCESS_AUD, 'CF_ACCESS_AUD'),
      readSecret(env.CF_ACCESS_ALLOWED_EMAIL, 'CF_ACCESS_ALLOWED_EMAIL'),
    ])
    const domain = new URL(teamDomain).origin
    if (!domain.startsWith('https://') || !new URL(domain).hostname.endsWith('.cloudflareaccess.com')) return undefined
    return { audience, domain, email: allowedEmail.toLowerCase() }
  } catch {
    return undefined
  }
}

export async function authorizePersonalRequest(request: Request, env: AppEnv, write = false): Promise<Response | undefined> {
  if (env.APP_MODE !== 'live') return undefined
  const config = await accessConfig(env)
  if (!config) return jsonNoStore({ error: 'Cloudflare Access is not configured' }, { status: 503 })
  const token = request.headers.get('Cf-Access-Jwt-Assertion')
  if (!token) return jsonNoStore({ error: 'Cloudflare Access authentication required' }, { status: 401 })
  try {
    const { payload } = await jwtVerify(token, accessKeySet(config.domain), {
      audience: config.audience,
      issuer: config.domain,
    })
    if (typeof payload.email !== 'string' || payload.email.toLowerCase() !== config.email) {
      return jsonNoStore({ error: 'This identity is not allowed' }, { status: 403 })
    }
  } catch {
    return jsonNoStore({ error: 'Invalid Cloudflare Access token' }, { status: 403 })
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
