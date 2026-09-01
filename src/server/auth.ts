import { betterAuth } from 'better-auth'

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

function configureAuth(
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
  })
}

type AuthRuntime = {
  auth: ReturnType<typeof configureAuth>
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

  return { auth }
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
