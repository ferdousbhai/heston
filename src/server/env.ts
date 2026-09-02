import { type DailyCandlesReadResult, type OptionGreeksReadResult } from './market-feed-contracts'


interface BrokerGateRpcStub {
  acquire(): Promise<void>
  acquireMutation(): Promise<string>
  renewMutation(token: string): Promise<void>
  releaseMutation(token: string): Promise<void>
}

interface BrokerGateNamespace {
  getByName(name: string): BrokerGateRpcStub
}

interface MarketFeedRpcStub {
  fetch(request: Request): Promise<Response>
  readDailyCandles(symbols: readonly string[]): Promise<DailyCandlesReadResult>
  readOptionGreeks(streamerSymbols: readonly string[]): Promise<OptionGreeksReadResult>
}

interface MarketFeedNamespace {
  get(id: DurableObjectId): MarketFeedRpcStub
  getByName(name: string): MarketFeedRpcStub
  idFromName(name: string): DurableObjectId
}

export interface AppEnv {
  AI?: Ai
  AI_GATEWAY_TOKEN?: SecretsStoreSecret
  AUTH_BASE_URL?: string
  BETTER_AUTH_SECRET?: string
  BROKER_GATE?: BrokerGateNamespace
  BROWSER?: BrowserRun
  DB?: D1Database
  DanAgent?: DurableObjectNamespace
  EXA_API_KEY?: SecretsStoreSecret
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  MARKET_FEED?: MarketFeedNamespace
  REDDIT_CLIENT_ID?: SecretsStoreSecret
  REDDIT_CLIENT_SECRET?: SecretsStoreSecret
  TASTYTRADE_API_BASE?: string
  SPICE_MCP_TOKEN?: SecretsStoreSecret
  TASTYTRADE_CLIENT_SECRET?: SecretsStoreSecret
  TASTYTRADE_REFRESH_TOKEN?: SecretsStoreSecret
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_LONG_VOL_CHAT_ID?: string
  /** Owner's private chat for operational alerts; never a publication destination. */
  TELEGRAM_OWNER_CHAT_ID?: SecretsStoreSecret
  XAI_API_KEY?: SecretsStoreSecret
}
