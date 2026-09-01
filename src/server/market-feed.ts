import { DurableObject } from 'cloudflare:workers'

import { type AppEnv } from './env'
import { MarketFeedCore } from './market-feed-core'
import { type DailyCandlesReadResult, type OptionGreeksReadResult } from './market-feed-contracts'

/**
 * The Durable Object the Workers runtime instantiates. It owns nothing but the
 * platform binding: every hook forwards to `MarketFeedCore`, which holds the relay
 * behaviour and can be exercised without the runtime.
 */
export class MarketFeed extends DurableObject<AppEnv> {
  private readonly core: MarketFeedCore

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env)
    this.core = new MarketFeedCore(ctx, env)
  }

  override fetch(request: Request): Promise<Response> {
    return this.core.fetch(request)
  }

  readOptionGreeks(streamerSymbols: readonly string[]): Promise<OptionGreeksReadResult> {
    return this.core.readOptionGreeks(streamerSymbols)
  }

  readDailyCandles(symbols: readonly string[]): Promise<DailyCandlesReadResult> {
    return this.core.readDailyCandles(symbols)
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    return this.core.webSocketMessage(socket, message)
  }

  override webSocketClose(): Promise<void> {
    return this.core.webSocketClose()
  }

  override webSocketError(): Promise<void> {
    return this.core.webSocketError()
  }

  override alarm(): Promise<void> {
    return this.core.alarm()
  }
}
