import { type OptionGreeksReadResult } from './market-feed-contracts'

export interface MarketFeedRpcStub {
  fetch(request: Request): Promise<Response>
  readOptionGreeks(streamerSymbols: readonly string[]): Promise<OptionGreeksReadResult>
}

export interface MarketFeedNamespace {
  get(id: DurableObjectId): MarketFeedRpcStub
  getByName(name: string): MarketFeedRpcStub
  idFromName(name: string): DurableObjectId
}

export interface AppEnv {
  AI?: Ai
  AI_GATEWAY_TOKEN?: SecretsStoreSecret
  APP_MODE?: string
  AUTH_BASE_URL?: string
  BETTER_AUTH_SECRET?: SecretsStoreSecret
  DB?: D1Database
  DanAgent?: DurableObjectNamespace
  GOOGLE_CLIENT_ID?: SecretsStoreSecret
  GOOGLE_CLIENT_SECRET?: SecretsStoreSecret
  MARKET_FEED?: MarketFeedNamespace
  REDDIT_CLIENT_ID?: SecretsStoreSecret
  REDDIT_CLIENT_SECRET?: SecretsStoreSecret
  TASTYTRADE_ACCOUNT_NUMBER?: SecretsStoreSecret
  TASTYTRADE_API_BASE?: string
  TASTYTRADE_CLIENT_SECRET?: SecretsStoreSecret
  TASTYTRADE_REFRESH_TOKEN?: SecretsStoreSecret
  XAI_API_KEY?: SecretsStoreSecret
}

export function isLiveTastytrade(env: AppEnv): boolean {
  return env.APP_MODE === 'live'
    && Boolean(env.TASTYTRADE_CLIENT_SECRET?.get)
    && Boolean(env.TASTYTRADE_REFRESH_TOKEN?.get)
}
