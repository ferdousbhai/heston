import { DurableObject } from 'cloudflare:workers'

import { type AppEnv, isLiveTastytrade } from './env'
import { type LiveMarketEvent, parseRequestedSymbols } from './market-feed-contracts'
import { loadQuoteToken } from './tastytrade'

type SocketAttachment = { symbols: string[] }
type JsonRecord = Record<string, unknown>

const CHANNELS = { Quote: 1, Trade: 3, Candle: 5 } as const
const FIELDS = {
  Quote: ['eventSymbol', 'eventTime', 'sequence', 'timeNanoPart', 'bidTime', 'bidExchangeCode', 'askTime', 'askExchangeCode', 'bidPrice', 'askPrice', 'bidSize', 'askSize'],
  Trade: ['eventSymbol', 'eventTime', 'time', 'timeNanoPart', 'sequence', 'exchangeCode', 'dayId', 'tickDirection', 'extendedTradingHours', 'price', 'change', 'size', 'dayVolume', 'dayTurnover'],
  Candle: ['eventSymbol', 'eventTime', 'eventFlags', 'index', 'time', 'sequence', 'count', 'volume', 'vwap', 'bidVolume', 'askVolume', 'impVolatility', 'openInterest', 'open', 'high', 'low', 'close'],
} as const

function object(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? value as JsonRecord : {}
}

function finite(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

function streamRows(type: keyof typeof FIELDS, values: unknown): JsonRecord[] {
  if (!Array.isArray(values)) return []
  const fields = FIELDS[type]
  const rows: JsonRecord[] = []
  for (let offset = 0; offset + fields.length <= values.length; offset += fields.length) {
    rows.push(Object.fromEntries(fields.map((field, index) => [field, values[offset + index]])))
  }
  return rows
}

function normalizedSymbol(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const symbol = value.split('{', 1)[0]?.toUpperCase()
  return symbol && /^[A-Z.]{1,8}$/.test(symbol) ? symbol : undefined
}

function eventFromRow(type: keyof typeof FIELDS, row: JsonRecord): LiveMarketEvent | undefined {
  const symbol = normalizedSymbol(row.eventSymbol)
  if (!symbol) return undefined
  const epoch = finite(row.time ?? row.eventTime)
  const timestamp = epoch && epoch > 1_000_000_000
    ? new Date(epoch < 10_000_000_000 ? epoch * 1_000 : epoch).toISOString()
    : new Date().toISOString()
  if (type === 'Quote') {
    const rawBid = finite(row.bidPrice)
    const rawAsk = finite(row.askPrice)
    const bid = rawBid !== undefined && rawBid > 0 ? rawBid : undefined
    const ask = rawAsk !== undefined && rawAsk > 0 ? rawAsk : undefined
    const price = bid !== undefined && ask !== undefined ? (bid + ask) / 2 : bid ?? ask
    return { type: 'market', symbol, ...(price !== undefined ? { price } : {}), ...(bid !== undefined ? { bid } : {}), ...(ask !== undefined ? { ask } : {}), timestamp }
  }
  if (type === 'Trade') {
    const price = finite(row.price)
    const change = finite(row.change)
    return { type: 'market', symbol, ...(price && price > 0 ? { price } : {}), ...(change !== undefined ? { change } : {}), timestamp }
  }
  const candleClose = finite(row.close)
  return { type: 'market', symbol, ...(candleClose && candleClose > 0 ? { candleClose } : {}), timestamp }
}

/** A single account-scoped relay: one secret-bearing DXLink socket, many authenticated clients. */
export class MarketFeed extends DurableObject<AppEnv> {
  private upstream?: WebSocket
  private subscribed = new Set<string>()
  private openedChannels = new Set<number>()
  private reconnectAttempt = 0
  private keepalive?: ReturnType<typeof setInterval>

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(() => this.reconcile())
  }

  async fetch(request: Request): Promise<Response> {
    if (!isLiveTastytrade(this.env)) return new Response('Live market data is disabled', { status: 503 })
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 })
    const symbols = parseRequestedSymbols(new URL(request.url))
    if (!symbols.length) return new Response('At least one valid symbol is required', { status: 400 })
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ symbols } satisfies SocketAttachment)
    await this.reconcile()
    return new Response(null, { status: 101, webSocket: client })
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== 'string') return
    try {
      const payload = object(JSON.parse(message))
      if (payload.type !== 'subscribe' || !Array.isArray(payload.symbols)) return
      const url = new URL('https://relay.invalid')
      url.searchParams.set('symbols', payload.symbols.join(','))
      const symbols = parseRequestedSymbols(url)
      if (!symbols.length) return
      socket.serializeAttachment({ symbols } satisfies SocketAttachment)
      void this.reconcile()
    } catch {
      // Ignore malformed client control frames; subscriptions remain unchanged.
    }
  }

  webSocketClose(): void { void this.reconcile() }
  webSocketError(): void { void this.reconcile() }

  async alarm(): Promise<void> {
    if (this.ctx.getWebSockets().length) await this.connectUpstream()
  }

  private downstreamSymbols(): Set<string> {
    return new Set(this.ctx.getWebSockets().flatMap((socket) => {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null
      return attachment?.symbols ?? []
    }))
  }

  private async reconcile(): Promise<void> {
    const next = this.downstreamSymbols()
    if (!next.size) {
      this.stopUpstream(1000, 'No subscribers')
      return
    }
    if (!this.upstream || this.upstream.readyState > WebSocket.OPEN) {
      await this.connectUpstream()
      return
    }
    if (this.upstream.readyState === WebSocket.OPEN && this.openedChannels.size) this.syncSubscriptions(next)
  }

  private async connectUpstream(): Promise<void> {
    if (this.upstream && this.upstream.readyState <= WebSocket.OPEN) return
    try {
      const credentials = await loadQuoteToken(this.env)
      const socket = new WebSocket(credentials.url)
      this.upstream = socket
      this.openedChannels.clear()
      socket.addEventListener('open', () => socket.send(JSON.stringify({
        type: 'SETUP', channel: 0, keepaliveTimeout: 60, acceptKeepaliveTimeout: 60,
        version: '0.1-DXF-JS/0.3.0',
      })))
      socket.addEventListener('message', (event) => this.handleUpstreamMessage(event.data, credentials.token))
      socket.addEventListener('close', () => this.handleUpstreamClose())
      socket.addEventListener('error', () => this.handleUpstreamClose())
    } catch (error) {
      console.error('MarketFeedConnectFailed', error instanceof Error ? error.message : 'UnknownError')
      await this.scheduleReconnect()
    }
  }

  private handleUpstreamMessage(raw: unknown, token: string): void {
    if (typeof raw !== 'string') return
    let message: JsonRecord
    try { message = object(JSON.parse(raw)) } catch { return }
    if (message.type === 'SETUP') {
      this.upstream?.send(JSON.stringify({ type: 'AUTH', channel: 0, token }))
      return
    }
    if (message.type === 'AUTH_STATE' && message.state === 'AUTHORIZED') {
      this.reconnectAttempt = 0
      for (const channel of Object.values(CHANNELS)) {
        this.upstream?.send(JSON.stringify({ type: 'CHANNEL_REQUEST', channel, service: 'FEED', parameters: { contract: 'AUTO' } }))
      }
      this.keepalive = setInterval(() => {
        if (this.upstream?.readyState === WebSocket.OPEN) this.upstream.send(JSON.stringify({ type: 'KEEPALIVE', channel: 0 }))
      }, 30_000)
      return
    }
    if (message.type === 'CHANNEL_OPENED') {
      const channel = finite(message.channel)
      const type = (Object.entries(CHANNELS).find(([, value]) => value === channel)?.[0]) as keyof typeof FIELDS | undefined
      if (!type || !channel) return
      this.openedChannels.add(channel)
      this.upstream?.send(JSON.stringify({
        type: 'FEED_SETUP', channel, acceptAggregationPeriod: 0.25,
        acceptDataFormat: 'COMPACT', acceptEventFields: { [type]: FIELDS[type] },
      }))
      this.syncSubscriptions(this.downstreamSymbols(), type)
      return
    }
    if (message.type === 'FEED_DATA' && Array.isArray(message.data)) this.broadcastFeedData(message.data)
    if (message.type === 'ERROR') console.error('MarketFeedProtocolError', String(message.message ?? 'UnknownError').slice(0, 160))
  }

  private syncSubscriptions(next: Set<string>, onlyType?: keyof typeof CHANNELS): void {
    const added = [...next].filter((symbol) => !this.subscribed.has(symbol))
    const removed = [...this.subscribed].filter((symbol) => !next.has(symbol))
    const types = onlyType ? [onlyType] : Object.keys(CHANNELS) as (keyof typeof CHANNELS)[]
    for (const type of types) {
      const channel = CHANNELS[type]
      if (!this.openedChannels.has(channel)) continue
      const decorate = (symbol: string) => type === 'Candle' ? `${symbol}{=5m}` : symbol
      const frame: JsonRecord = { type: 'FEED_SUBSCRIPTION', channel }
      if (added.length) frame.add = added.map((symbol) => ({ symbol: decorate(symbol), type }))
      if (removed.length) frame.remove = removed.map((symbol) => ({ symbol: decorate(symbol), type }))
      if (added.length || removed.length) this.upstream?.send(JSON.stringify(frame))
    }
    if (!onlyType) this.subscribed = next
    else if (this.openedChannels.size === Object.keys(CHANNELS).length) this.subscribed = next
  }

  private broadcastFeedData(data: unknown[]): void {
    const descriptor = data[0]
    const type = (typeof descriptor === 'string' ? descriptor : Array.isArray(descriptor) ? descriptor[0] : undefined) as keyof typeof FIELDS | undefined
    if (!type || !(type in FIELDS)) return
    for (const row of streamRows(type, data[1])) {
      const event = eventFromRow(type, row)
      if (!event) continue
      const serialized = JSON.stringify(event)
      for (const socket of this.ctx.getWebSockets()) {
        const symbols = (socket.deserializeAttachment() as SocketAttachment | null)?.symbols ?? []
        if (symbols.includes(event.symbol)) {
          try { socket.send(serialized) } catch { socket.close(1011, 'Delivery failed') }
        }
      }
    }
  }

  private handleUpstreamClose(): void {
    if (this.upstream?.readyState === WebSocket.OPEN) return
    this.upstream = undefined
    this.openedChannels.clear()
    this.subscribed.clear()
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = undefined
    if (this.ctx.getWebSockets().length) void this.scheduleReconnect()
  }

  private async scheduleReconnect(): Promise<void> {
    const delay = Math.min(60, 2 ** Math.min(this.reconnectAttempt++, 6))
    await this.ctx.storage.setAlarm(Date.now() + delay * 1_000)
  }

  private stopUpstream(code: number, reason: string): void {
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = undefined
    this.upstream?.close(code, reason)
    this.upstream = undefined
    this.openedChannels.clear()
    this.subscribed.clear()
    void this.ctx.storage.deleteAlarm()
  }
}
