import { DurableObject } from 'cloudflare:workers'

import { MAX_INTRADAY_CANDLES, type CandlePoint, updateCandleSeries } from '../domain/candle'
import { type AppEnv } from './env'
import {
  DXLINK_REMOVE_EVENT,
  DXLINK_SNAPSHOT_BEGIN,
  candleSubscription,
  type LiveMarketEvent,
  type MarketFeedStatus,
  type OptionGreeksReadResult,
  OptionGreeksReadResultSchema,
  OptionGreeksRequestRegistry,
  optionGreeksFromRow,
  parseOptionStreamerSymbols,
  parseRequestedSymbols,
} from './market-feed-contracts'
import { loadEquityCandleFromTime, loadQuoteToken } from './tastytrade'

type SocketAttachment = { symbols: string[] }
type JsonRecord = Record<string, unknown>

const CHANNELS = { Quote: 1, Trade: 3, Candle: 5, Greeks: 7 } as const
const FIELDS = {
  Quote: ['eventSymbol', 'eventTime', 'sequence', 'timeNanoPart', 'bidTime', 'bidExchangeCode', 'askTime', 'askExchangeCode', 'bidPrice', 'askPrice', 'bidSize', 'askSize'],
  Trade: ['eventSymbol', 'eventTime', 'time', 'timeNanoPart', 'sequence', 'exchangeCode', 'dayId', 'tickDirection', 'extendedTradingHours', 'price', 'change', 'size', 'dayVolume', 'dayTurnover'],
  Candle: ['eventSymbol', 'eventTime', 'eventFlags', 'index', 'time', 'sequence', 'count', 'volume', 'vwap', 'bidVolume', 'askVolume', 'impVolatility', 'openInterest', 'open', 'high', 'low', 'close'],
  Greeks: ['eventSymbol', 'eventFlags', 'index', 'time', 'sequence', 'price', 'volatility', 'delta', 'gamma', 'theta', 'rho', 'vega'],
} as const

type FeedType = keyof typeof FIELDS

const OPTION_GREEKS_TIMEOUT_MS = 10_000
const UPSTREAM_SETUP_TIMEOUT_MS = 15_000

function object(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? value as JsonRecord : {}
}

function finite(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

function streamRows(type: FeedType, values: unknown): JsonRecord[] {
  if (!Array.isArray(values)) return []
  const fields = FIELDS[type]
  if (values.length % fields.length !== 0) return []
  const rows: JsonRecord[] = []
  for (let offset = 0; offset + fields.length <= values.length; offset += fields.length) {
    rows.push(Object.fromEntries(fields.map((field, index) => [field, values[offset + index]])))
  }
  return rows
}

function eventTimestamp(row: JsonRecord): string | undefined {
  const epoch = finite(row.time ?? row.eventTime)
  if (epoch === undefined || epoch <= 1_000_000_000) return undefined
  const milliseconds = epoch < 10_000_000_000 ? epoch * 1_000 : epoch
  if (!Number.isSafeInteger(milliseconds)) return undefined
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function normalizedSymbol(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const symbol = value.split('{', 1)[0]?.toUpperCase()
  return symbol && /^[A-Z.]{1,8}$/.test(symbol) ? symbol : undefined
}

function eventFromRow(type: Exclude<FeedType, 'Greeks'>, row: JsonRecord): LiveMarketEvent | undefined {
  const symbol = normalizedSymbol(row.eventSymbol)
  const timestamp = eventTimestamp(row)
  if (!symbol || !timestamp) return undefined
  if (type === 'Quote') {
    const rawBid = finite(row.bidPrice)
    const rawAsk = finite(row.askPrice)
    const bid = rawBid !== undefined && rawBid > 0 ? rawBid : undefined
    const ask = rawAsk !== undefined && rawAsk > 0 ? rawAsk : undefined
    if (bid === undefined || ask === undefined || bid > ask) return undefined
    return { type: 'market', symbol, price: (bid + ask) / 2, bid, ask, timestamp }
  }
  if (type === 'Trade') {
    const price = finite(row.price)
    const change = finite(row.change)
    if (price === undefined || price <= 0) return undefined
    return { type: 'market', symbol, price, ...(change !== undefined ? { change } : {}), timestamp }
  }
  const candleClose = finite(row.close)
  const candleTime = finite(row.time)
  const sequence = finite(row.sequence) ?? 0
  const eventFlags = finite(row.eventFlags) ?? 0
  if (candleTime === undefined || candleTime < 0 || !Number.isInteger(candleTime)) return undefined
  if (!(eventFlags & DXLINK_REMOVE_EVENT) && !(candleClose && candleClose > 0)) return undefined
  return {
    type: 'market',
    symbol,
    candle: {
      time: candleTime,
      sequence: Math.max(0, Math.trunc(sequence)),
      close: candleClose && candleClose > 0 ? candleClose : 0,
      eventFlags: Math.max(0, Math.trunc(eventFlags)),
    },
    timestamp,
  }
}

/** A single account-scoped relay: one secret-bearing DXLink socket, many authenticated clients and RPC reads. */
export class MarketFeed extends DurableObject<AppEnv> {
  private upstream?: WebSocket
  private connectInFlight?: Promise<void>
  private reconcileInFlight?: Promise<void>
  private reconcileNeeded = false
  private readonly subscribedByType = new Map<FeedType, Set<string>>()
  private openedChannels = new Set<number>()
  private reconnectAttempt = 0
  private keepalive?: ReturnType<typeof setInterval>
  private setupTimeout?: ReturnType<typeof setTimeout>
  private candleFromTime = Date.now() - 7 * 24 * 60 * 60 * 1_000
  private candles = new Map<string, CandlePoint[]>()
  private readonly greekRequests = new OptionGreeksRequestRegistry()
  private feedState: MarketFeedStatus['state'] = 'connecting'

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env)
    // Inbound sockets hibernate with the object; the outbound DXLink socket does not.
    if (ctx.getWebSockets().length) this.track(this.reconcile())
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 })
    const symbols = parseRequestedSymbols(new URL(request.url))
    if (!symbols.length) return new Response('At least one valid symbol is required', { status: 400 })
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ symbols } satisfies SocketAttachment)
    this.sendStatus(server, this.feedState)
    await this.reconcile()
    this.replayCandles(server, symbols)
    return new Response(null, { status: 101, webSocket: client })
  }

  /** Read a bounded exact set of option Greeks over the account's shared upstream socket. */
  async readOptionGreeks(streamerSymbols: readonly string[]): Promise<OptionGreeksReadResult> {
    const symbols = parseOptionStreamerSymbols(streamerSymbols)
    const lease = this.greekRequests.register(symbols, OPTION_GREEKS_TIMEOUT_MS)
    try {
      await this.reconcile()
      const greeks = await lease.promise
      return OptionGreeksReadResultSchema.parse({
        asOf: new Date().toISOString(),
        greeks,
        impliedVolatilityUnit: 'decimal_ratio',
        source: 'tastytrade-dxlink',
      })
    } finally {
      lease.release()
      await this.reconcile().catch((error) => this.logError('MarketFeedCleanupFailed', error))
    }
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    try {
      const payload = object(JSON.parse(message))
      if (payload.type !== 'subscribe' || !Array.isArray(payload.symbols)) return
      const url = new URL('https://relay.invalid')
      url.searchParams.set('symbols', payload.symbols.join(','))
      const symbols = parseRequestedSymbols(url)
      if (!symbols.length) return
      socket.serializeAttachment({ symbols } satisfies SocketAttachment)
      await this.reconcile()
    } catch {
      // Ignore malformed client control frames; subscriptions remain unchanged.
    }
  }

  async webSocketClose(): Promise<void> { await this.reconcile() }
  async webSocketError(): Promise<void> { await this.reconcile() }

  async alarm(): Promise<void> {
    await this.reconcile()
  }

  private downstreamSymbols(): Set<string> {
    return new Set(this.ctx.getWebSockets().flatMap((socket) => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null
      return attachment?.symbols ?? []
    }))
  }

  private hasDemand(): boolean {
    return this.downstreamSymbols().size > 0 || this.greekRequests.demandSymbols().size > 0
  }

  private desiredSymbols(type: FeedType): Set<string> {
    return type === 'Greeks' ? this.greekRequests.demandSymbols() : this.downstreamSymbols()
  }

  private async reconcile(): Promise<void> {
    this.reconcileNeeded = true
    for (;;) {
      if (this.reconcileInFlight) {
        await this.reconcileInFlight
        if (!this.reconcileNeeded) return
        continue
      }
      this.reconcileNeeded = false
      const attempt = this.reconcileOnce()
      this.reconcileInFlight = attempt
      try {
        await attempt
      } finally {
        if (this.reconcileInFlight === attempt) this.reconcileInFlight = undefined
      }
      if (!this.reconcileNeeded) return
    }
  }

  private async reconcileOnce(): Promise<void> {
    if (!this.hasDemand()) {
      await this.stopUpstream(1000, 'No subscribers')
      return
    }
    await this.connectUpstream()
    const socket = this.upstream
    if (socket?.readyState === WebSocket.OPEN && this.openedChannels.size) {
      await this.syncSubscriptions(socket)
    }
  }

  private async connectUpstream(): Promise<void> {
    if (this.upstream && this.upstream.readyState <= WebSocket.OPEN) return
    if (this.connectInFlight) return this.connectInFlight
    const attempt = this.openUpstream()
    this.connectInFlight = attempt
    try {
      await attempt
    } catch (error) {
      this.logError('MarketFeedConnectFailed', error)
      if (this.hasDemand()) await this.scheduleReconnect()
    } finally {
      if (this.connectInFlight === attempt) this.connectInFlight = undefined
    }
  }

  private async openUpstream(): Promise<void> {
    this.broadcastStatus('connecting')
    const [credentials, candleFromTime] = await Promise.all([
      loadQuoteToken(this.env),
      loadEquityCandleFromTime(this.env).catch(() => this.candleFromTime),
    ])
    if (!this.hasDemand() || (this.upstream && this.upstream.readyState <= WebSocket.OPEN)) return
    this.candleFromTime = candleFromTime
    const socket = new WebSocket(credentials.url)
    this.upstream = socket
    this.openedChannels.clear()
    this.clearSetupTimeout()
    this.setupTimeout = setTimeout(() => {
      if (socket !== this.upstream || this.openedChannels.size === Object.keys(CHANNELS).length) return
      this.track(this.handleSetupTimeout(socket))
    }, UPSTREAM_SETUP_TIMEOUT_MS)
    socket.addEventListener('open', () => this.track(this.handleUpstreamOpen(socket)))
    socket.addEventListener('message', (event) => this.track(this.handleUpstreamMessage(socket, event.data, credentials.token)))
    socket.addEventListener('close', () => this.track(this.handleUpstreamClose(socket)))
    socket.addEventListener('error', () => this.track(this.handleUpstreamError(socket)))
  }

  private async handleUpstreamOpen(socket: WebSocket): Promise<void> {
    if (socket !== this.upstream) {
      socket.close(1000, 'Superseded')
      return
    }
    await this.sendToUpstream(socket, {
      type: 'SETUP', channel: 0, keepaliveTimeout: 60, acceptKeepaliveTimeout: 60,
      version: '0.1-DXF-JS/0.3.0',
    })
  }

  private async handleUpstreamMessage(socket: WebSocket, raw: unknown, token: string): Promise<void> {
    if (socket !== this.upstream || typeof raw !== 'string') return
    let message: JsonRecord
    try { message = object(JSON.parse(raw)) } catch { return }
    if (message.type === 'SETUP') {
      await this.sendToUpstream(socket, { type: 'AUTH', channel: 0, token })
      return
    }
    if (message.type === 'AUTH_STATE' && message.state === 'AUTHORIZED') {
      this.reconnectAttempt = 0
      if (this.keepalive) clearInterval(this.keepalive)
      for (const channel of Object.values(CHANNELS)) {
        if (!await this.sendToUpstream(socket, { type: 'CHANNEL_REQUEST', channel, service: 'FEED', parameters: { contract: 'AUTO' } })) return
      }
      this.keepalive = setInterval(() => {
        this.track(this.sendToUpstream(socket, { type: 'KEEPALIVE', channel: 0 }).then(() => undefined))
      }, 30_000)
      return
    }
    if (message.type === 'AUTH_STATE') {
      await this.failProtocol(socket, `Authorization ${String(message.state ?? 'failed')}`)
      return
    }
    if (message.type === 'CHANNEL_OPENED') {
      const channel = finite(message.channel)
      const type = (Object.entries(CHANNELS).find(([, value]) => value === channel)?.[0]) as FeedType | undefined
      if (!type || !channel) return
      this.openedChannels.add(channel)
      if (this.openedChannels.size === Object.keys(CHANNELS).length) {
        this.clearSetupTimeout()
        this.broadcastStatus('live')
      }
      if (!await this.sendToUpstream(socket, {
        type: 'FEED_SETUP', channel, acceptAggregationPeriod: 0.25,
        acceptDataFormat: 'COMPACT', acceptEventFields: { [type]: FIELDS[type] },
      })) return
      await this.reconcile()
      return
    }
    if (message.type === 'FEED_DATA' && Array.isArray(message.data)) this.broadcastFeedData(message.data)
    if (message.type === 'ERROR' || message.type === 'CHANNEL_CLOSED') {
      await this.failProtocol(socket, String(message.message ?? message.type).slice(0, 160))
    }
  }

  private async syncSubscriptions(socket: WebSocket): Promise<void> {
    for (const type of Object.keys(CHANNELS) as FeedType[]) {
      const channel = CHANNELS[type]
      if (!this.openedChannels.has(channel)) continue
      const next = this.desiredSymbols(type)
      const current = this.subscribedByType.get(type) ?? new Set<string>()
      const added = [...next].filter((symbol) => !current.has(symbol))
      const removed = [...current].filter((symbol) => !next.has(symbol))
      const decorate = (symbol: string) => type === 'Candle' ? `${symbol}{=5m,tho=true}` : symbol
      const frame: JsonRecord = { type: 'FEED_SUBSCRIPTION', channel }
      if (added.length) frame.add = added.map((symbol) => type === 'Candle'
        ? candleSubscription(symbol, this.candleFromTime)
        : { symbol: decorate(symbol), type })
      if (removed.length) frame.remove = removed.map((symbol) => ({ symbol: decorate(symbol), type }))
      if ((added.length || removed.length) && !await this.sendToUpstream(socket, frame)) return
      this.subscribedByType.set(type, next)
    }
  }

  private broadcastFeedData(data: unknown[]): void {
    const descriptor = data[0]
    const type = (typeof descriptor === 'string' ? descriptor : Array.isArray(descriptor) ? descriptor[0] : undefined) as FeedType | undefined
    if (!type || !(type in FIELDS)) return
    for (const row of streamRows(type, data[1])) {
      if (type === 'Greeks') {
        const event = optionGreeksFromRow(row)
        if (event) this.greekRequests.accept(event)
        continue
      }
      const event = eventFromRow(type, row)
      if (!event) continue
      this.cacheCandle(event)
      const serialized = JSON.stringify(event)
      for (const socket of this.ctx.getWebSockets()) {
        const symbols = (socket.deserializeAttachment() as SocketAttachment | null)?.symbols ?? []
        if (symbols.includes(event.symbol)) {
          try { socket.send(serialized) } catch { socket.close(1011, 'Delivery failed') }
        }
      }
    }
  }

  private cacheCandle(event: LiveMarketEvent): void {
    if (!event.candle) return
    const { eventFlags, ...point } = event.candle
    const current = eventFlags & DXLINK_SNAPSHOT_BEGIN ? [] : this.candles.get(event.symbol) ?? []
    this.candles.set(event.symbol, updateCandleSeries(
      current,
      point,
      Boolean(eventFlags & DXLINK_REMOVE_EVENT),
      MAX_INTRADAY_CANDLES,
    ))
  }

  private replayCandles(socket: WebSocket, symbols: readonly string[]): void {
    for (const symbol of symbols) {
      const candleSnapshot = this.candles.get(symbol)
      if (!candleSnapshot?.length) continue
      try {
        socket.send(JSON.stringify({
          type: 'market', symbol, candleSnapshot, timestamp: new Date().toISOString(),
        } satisfies LiveMarketEvent))
      } catch {
        socket.close(1011, 'Delivery failed')
        return
      }
    }
  }

  private async handleUpstreamError(socket: WebSocket): Promise<void> {
    if (socket !== this.upstream) return
    try { socket.close(1011, 'Upstream error') } catch { /* Already closed. */ }
    await this.handleUpstreamClose(socket)
  }

  private async handleSetupTimeout(socket: WebSocket): Promise<void> {
    if (socket !== this.upstream) return
    try { socket.close(1013, 'Upstream setup timed out') } catch { /* Already closed. */ }
    await this.handleUpstreamClose(socket)
  }

  private async handleUpstreamClose(socket: WebSocket): Promise<void> {
    if (socket !== this.upstream) return
    this.upstream = undefined
    this.openedChannels.clear()
    this.subscribedByType.clear()
    this.clearSetupTimeout()
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = undefined
    if (this.hasDemand()) {
      this.broadcastStatus('reconnecting')
      await this.scheduleReconnect()
    }
    else await this.ctx.storage.deleteAlarm()
  }

  private async scheduleReconnect(): Promise<void> {
    const delay = Math.min(60, 2 ** Math.min(this.reconnectAttempt++, 6))
    await this.ctx.storage.setAlarm(Date.now() + delay * 1_000)
  }

  private async stopUpstream(code: number, reason: string): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = undefined
    const socket = this.upstream
    this.upstream = undefined
    this.openedChannels.clear()
    this.subscribedByType.clear()
    this.clearSetupTimeout()
    try { socket?.close(code, reason) } catch { /* Already closed. */ }
    await this.ctx.storage.deleteAlarm()
  }

  private async failProtocol(socket: WebSocket, detail: string): Promise<void> {
    if (socket !== this.upstream) return
    this.logError('MarketFeedProtocolError', detail)
    this.broadcastStatus('degraded', detail)
    try { socket.close(1011, 'Upstream protocol failure') } catch { /* Already closed. */ }
    await this.handleUpstreamClose(socket)
  }

  private broadcastStatus(state: MarketFeedStatus['state'], detail?: string): void {
    this.feedState = state
    for (const socket of this.ctx.getWebSockets()) this.sendStatus(socket, state, detail)
  }

  private sendStatus(socket: WebSocket, state: MarketFeedStatus['state'], detail?: string): void {
    try {
      socket.send(JSON.stringify({
        asOf: new Date().toISOString(),
        ...(detail ? { detail: detail.slice(0, 160) } : {}),
        state,
        type: 'feed-status',
      } satisfies MarketFeedStatus))
    } catch {
      try { socket.close(1011, 'Status delivery failed') } catch { /* Already closed. */ }
    }
  }

  private async sendToUpstream(socket: WebSocket, frame: JsonRecord): Promise<boolean> {
    if (socket !== this.upstream || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch (error) {
      this.logError('MarketFeedSendFailed', error)
      try { socket.close(1011, 'Send failed') } catch { /* Already closed. */ }
      await this.handleUpstreamClose(socket)
      return false
    }
  }

  private track(task: Promise<void>): void {
    this.ctx.waitUntil(task.catch((error) => this.logError('MarketFeedLifecycleFailed', error)))
  }

  private clearSetupTimeout(): void {
    if (this.setupTimeout) clearTimeout(this.setupTimeout)
    this.setupTimeout = undefined
  }

  private logError(event: string, error: unknown): void {
    console.error(event, error instanceof Error ? error.message : 'UnknownError')
  }
}
