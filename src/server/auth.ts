import { mcp } from '@better-auth/mcp'
import { betterAuth } from 'better-auth'
import { jwt } from 'better-auth/plugins/jwt'

import { type AppEnv } from './env'
import { readBoundSecret } from './secrets'

export const OWNER_EMAIL = 'ferdousbd@gmail.com'

export function isOwnerEmail(email: string): boolean {
  return email.toLowerCase() === OWNER_EMAIL
}

export type AuthenticatedIdentity = { email: string; id: string; name: string }

function requireProductionOrigin(value: string | undefined): string {
  if (!value) throw new Error('AuthBaseUrlMissing')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('AuthBaseUrlInvalid')
  }
  return url.origin
}

export function configureAuth(
  database: D1Database,
  baseURL: string,
  secret: string,
  googleClientId: string,
  googleClientSecret: string,
) {
  return betterAuth({
    appName: 'Spice Must Flow',
    baseURL,
    database,
    secret,
    trustedOrigins: [baseURL],
    socialProviders: {
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        prompt: 'select_account',
      },
    },
    account: {
      encryptOAuthTokens: true,
    },
    plugins: [
      // Access tokens are signed JWTs, so the provider needs somewhere to keep signing keys and a
      // JWKS to publish. Private keys live in `jwks` and no read path may return one.
      jwt(),
      /*
       * The authorization server that lets an MCP client connect without anyone copying a token.
       *
       * Spice issues its own tokens rather than pointing clients at Google, because Google offers
       * neither dynamic client registration nor the loopback redirect URIs an MCP client registers
       * for itself. Google stays the identity; this only decides who mints the token in front of it.
       *
       * Registration is open by necessity -- that is how a client bootstraps -- so consent is what
       * stands between a registered client and an account. Every newly registered client is
       * consented to explicitly; nothing here is trusted by default.
       */
      mcp({
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        consentPage: '/connect',
        loginPage: '/connect',
        // Audience-binds every issued token to this endpoint (RFC 8707), so a token minted for
        // Spice cannot be replayed against another resource that trusts the same issuer.
        resource: mcpResourceIdentifier(baseURL),
      }),
    ],
  })
}

/**
 * The MCP endpoint as an OAuth protected-resource identifier (RFC 8707).
 *
 * Every issued token is audience-bound to this exact string, and verification checks it, so the
 * two must be derived from one definition or a token minted for Spice would be accepted for
 * something else that trusts the same issuer -- or, more likely, nothing would authenticate.
 */
export function mcpResourceIdentifier(baseURL: string): string {
  return `${baseURL}/mcp`
}

type AuthRuntime = {
  auth: ReturnType<typeof configureAuth>
  mcpResource: string
}

let cachedRuntime: Promise<AuthRuntime> | undefined

async function createAuthRuntime(env: AppEnv): Promise<AuthRuntime> {
  if (!env.DB) throw new Error('AuthDatabaseMissing')
  const secret = readBoundSecret(env.BETTER_AUTH_SECRET, 'BETTER_AUTH_SECRET')
  const googleClientId = readBoundSecret(env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID')
  const googleClientSecret = readBoundSecret(env.GOOGLE_CLIENT_SECRET, 'GOOGLE_CLIENT_SECRET')
  if (secret.length < 32) throw new Error('AuthSecretTooShort')
  const baseURL = requireProductionOrigin(env.AUTH_BASE_URL)

  const auth = configureAuth(env.DB, baseURL, secret, googleClientId, googleClientSecret)

  return { auth, mcpResource: mcpResourceIdentifier(baseURL) }
}

/** A failed build must not stay cached, so the next request retries from scratch. */
async function buildAuthRuntime(env: AppEnv): Promise<AuthRuntime> {
  try {
    return await createAuthRuntime(env)
  } catch (error) {
    cachedRuntime = undefined
    throw error
  }
}

export function getAuthRuntime(env: AppEnv): Promise<AuthRuntime> {
  cachedRuntime ??= buildAuthRuntime(env)
  return cachedRuntime
}

/** Google identity is available to favorite sync; it grants no brokerage or agent authority. */
export async function getAuthenticatedIdentity(
  request: Request,
  env: AppEnv,
): Promise<AuthenticatedIdentity | null> {
  const runtime = await getAuthRuntime(env)
  const session = await runtime.auth.api.getSession({ headers: request.headers })
  if (!session) return null
  return { email: session.user.email, id: session.user.id, name: session.user.name }
}

/**
 * The OAuth discovery documents an MCP client fetches before it can authenticate.
 *
 * RFC 9728 and RFC 8414 define these as root-relative, so a client only ever looks for them at
 * the origin. better-auth does not publish them uniformly: the protected-resource document is
 * already served at the root (with or without the resource path suffix), while the authorization
 * server metadata lives under the auth base path. Both shapes are named here rather than guessed,
 * because a 404 on either one reads to a client as "this server has no OAuth" and the whole flow
 * stops before it starts.
 *
 * Only these names are handled, and each maps to one fixed path, so this cannot become a second
 * unintended mount of the auth surface.
 */
const ROOT_DISCOVERY_DOCUMENT = 'oauth-protected-resource'
const BASE_PATH_DISCOVERY_DOCUMENTS = new Set(['oauth-authorization-server', 'openid-configuration'])

export async function handleWellKnownDiscovery(
  request: Request,
  env: AppEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url)
  const prefix = '/.well-known/'
  if (!url.pathname.startsWith(prefix)) return undefined
  const document = url.pathname.slice(prefix.length).split('/')[0] ?? ''
  const rootServed = document === ROOT_DISCOVERY_DOCUMENT
  if (!rootServed && !BASE_PATH_DISCOVERY_DOCUMENTS.has(document)) return undefined
  try {
    const { auth } = await getAuthRuntime(env)
    const forwarded = rootServed ? url : new URL(`/api/auth${url.pathname}${url.search}`, url.origin)
    return await auth.handler(new Request(forwarded, { headers: request.headers, method: 'GET' }))
  } catch (error) {
    console.error('AuthDiscoveryUnavailable', error instanceof Error ? error.name : 'UnknownError')
    return Response.json({ error: 'Discovery is temporarily unavailable' }, {
      headers: { 'Cache-Control': 'no-store' },
      status: 503,
    })
  }
}
