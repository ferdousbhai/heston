export interface AppEnv {
  AI?: Ai
  APP_MODE?: string
  CF_ACCESS_ALLOWED_EMAIL?: SecretsStoreSecret
  CF_ACCESS_AUD?: SecretsStoreSecret
  CF_ACCESS_TEAM_DOMAIN?: SecretsStoreSecret
  DB?: D1Database
  REDDIT_CLIENT_ID?: SecretsStoreSecret
  REDDIT_CLIENT_SECRET?: SecretsStoreSecret
  TASTYTRADE_ACCOUNT_NUMBER?: SecretsStoreSecret
  TASTYTRADE_API_BASE?: string
  TASTYTRADE_CLIENT_SECRET?: SecretsStoreSecret
  TASTYTRADE_REFRESH_TOKEN?: SecretsStoreSecret
}

export function isLiveTastytrade(env: AppEnv): boolean {
  return env.APP_MODE === 'live'
    && Boolean(env.TASTYTRADE_CLIENT_SECRET?.get)
    && Boolean(env.TASTYTRADE_REFRESH_TOKEN?.get)
}
