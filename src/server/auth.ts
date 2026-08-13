import { betterAuth } from 'better-auth'
import { APIError } from 'better-auth/api'

import { type AppEnv } from './env'
import { readSecret } from './secrets'

const AUTHORIZED_EMAIL = 'ferdousbd@gmail.com'

export function isAuthorizedEmail(email: string): boolean {
  return email.toLowerCase() === AUTHORIZED_EMAIL
}

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
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isAuthorizedEmail(user.email)) {
              throw new APIError('FORBIDDEN', { message: 'This Google account is not invited to Spice.' })
            }
            return { data: user }
          },
        },
      },
    },
  })
}

type AuthRuntime = {
  auth: ReturnType<typeof configureAuth>
}

let cachedRuntime: Promise<AuthRuntime> | undefined

async function createAuthRuntime(env: AppEnv): Promise<AuthRuntime> {
  if (!env.DB) throw new Error('AuthDatabaseMissing')
  const [secret, googleClientId, googleClientSecret] = await Promise.all([
    readSecret(env.BETTER_AUTH_SECRET, 'BETTER_AUTH_SECRET'),
    readSecret(env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID'),
    readSecret(env.GOOGLE_CLIENT_SECRET, 'GOOGLE_CLIENT_SECRET'),
  ])
  if (secret.length < 32) throw new Error('AuthSecretTooShort')
  const baseURL = requireProductionOrigin(env.AUTH_BASE_URL)

  const auth = configureAuth(env.DB, baseURL, secret, googleClientId, googleClientSecret)

  return { auth }
}

export function getAuthRuntime(env: AppEnv): Promise<AuthRuntime> {
  if (!cachedRuntime) {
    cachedRuntime = createAuthRuntime(env).catch((error: unknown) => {
      cachedRuntime = undefined
      throw error
    })
  }
  return cachedRuntime
}

export async function getOwnerSession(request: Request, env: AppEnv) {
  const runtime = await getAuthRuntime(env)
  const session = await runtime.auth.api.getSession({ headers: request.headers })
  if (!session || !isAuthorizedEmail(session.user.email)) return null
  return session
}
