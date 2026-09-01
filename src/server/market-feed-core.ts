import { z } from 'zod'

import { MAX_INTRADAY_CANDLES, type CandlePoint, updateCandleSeries } from '../domain/candle'
import { toError } from '../domain/failure'
import { EquitySymbolSchema } from '../domain/instrument'
import { MAX_WATCHLIST_SYMBOLS } from '../domain/watchlist'
import { type AppEnv } from './env'
import {
  DXLINK_REMOVE_EVENT,
  DXLINK_SNAPSHOT_BEGIN,
  DailyCandleRequestRegistry,
  type DailyCandlesReadResult,
  DailyCandlesReadResultSchema,
  candleFeedPeriod,
  candleSubscription,
  type LiveMarketEvent,
  MarketFeedSymbolsSchema,
  type MarketFeedStatus,
  type OptionGreeksReadResult,
  OptionGreeksReadResultSchema,
  OptionGreeksRequestRegistry,
  optionGreeksFromRow,
  parseMarketFeedSymbols,
  parseOptionStreamerSymbols,
  parseRequestedSymbols,
} from './market-feed-contracts'
// dxFeed COMPACT rows encode absent numeric slots as null or empty strings, which
// `jsonNumber` already reads back as absent.
import { JsonArraySchema, jsonNumber, JsonObjectSchema, type JsonObject, type JsonValue } from '../domain/json-payload'
import { brokerApi } from './tastytrade'

const SocketAttachmentSchema = z.object({
  seenAt: z.number().int().nonnegative().optional(),
  symbols: MarketFeedSymbolsSchema,
}).strict()
type SocketAttachment = z.infer<typeof SocketAttachmentSchema>
const SubscriptionFrameSchema = z.object({
  symbols: MarketFeedSymbolsSchema,
  type: z.literal('subscribe'),
}).strict()
/** A reader saying it is still there. Any inbound frame proves liveness; this one costs nothing. */
const HeartbeatFrameSchema = z.object({ type: z.literal('heartbeat') }).strict()
const TextFrameSchema = z.string()

const CHANNELS = { Quote: 1, Trade: 3, Candle: 5, Greeks: 7 } as const
const FIELDS = {
  Quote: ['eventSymbol', 'eventTime', 'sequence', 'timeNanoPart', 'bidTime', 'bidExchangeCode', 'askTime', 'askExchangeCode', 'bidPrice', 'askPrice', 'bidSize', 'askSize'],
  Trade: ['eventSymbol', 'eventTime', 'time', 'timeNanoPart', 'sequence', 'exchangeCode', 'dayId', 'tickDirection', 'extendedTradingHours', 'price', 'change', 'size', 'dayVolume', 'dayTurnover'],
  Candle: ['eventSymbol', 'eventTime', 'eventFlags', 'index', 'time', 'sequence', 'count', 'volume', 'vwap', 'bidVolume', 'askVolume', 'impVolatility', 'openInterest', 'open', 'high', 'low', 'close'],
  Greeks: ['eventSymbol', 'eventFlags', 'index', 'time', 'sequence', 'price', 'volatility', 'delta', 'gamma', 'theta', 'rho', 'vega'],
} as const

type FeedType = keyof typeof FIELDS

const FEED_TYPES = ['Quote', 'Trade', 'Candle', 'Greeks'] as const satisfies readonly FeedType[]

/**
 * A browser that crashes, sleeps, or loses its network never sends a close frame, so the relay
 * would otherwise keep an upstream connection open for a reader who is no longer there. Clients
 * announce themselves on this cadence and are dropped after missing several in a row.
 */
const CLIENT_HEARTBEAT_MS = 30_000
const CLIENT_IDLE_TIMEOUT_MS = 3 * CLIENT_HEARTBEAT_MS
// One connection can still carry too many subscriptions: this bounds the union across readers.
const MAX_RELAYED_SYMBOLS = MAX_WATCHLIST_SYMBOLS
// These bound one interactive read/setup attempt; the persistent relay reconnects separately.
const OPTION_GREEKS_TIMEOUT_MS = 10_000
const UPSTREAM_SETUP_TIMEOUT_MS = 15_000
// Durable alarms provide bounded exponential reconnects while any client or Greeks read remains.
// Reaches past a weekend plus a holiday, so the backfill always clears the bar cap even on a
// Monday morning. The cap, not this window, decides how much of the series survives.
const CANDLE_BACKFILL_MS = 4 * 24 * 60 * 60 * 1_000
// A year of closes, with slack so the oldest week is not clipped by an inclusive boundary.
const YEAR_CANDLE_BACKFILL_MS = 372 * 24 * 60 * 60 * 1_000
// A year of daily bars for a whole watchlist is a large snapshot, so this waits longer than
// the interactive Greeks read. Nothing blocks on it: the caller is a background refresh.
const DAILY_CANDLE_TIMEOUT_MS = 60_000
/**
 * A quote token outlives a single connection, and re-fetching one on every reconnect turns a
 * dropped websocket into a REST call. Held well inside the provider's documented lifetime, and
 * discarded the moment the upstream rejects it, so a stale token costs one failed handshake.
 */
const QUOTE_TOKEN_TTL_MS = 12 * 60 * 60 * 1_000
const RECONNECT_BASE_DELAY_SECONDS = 1
const RECONNECT_MAX_DELAY_SECONDS = 60
const RECONNECT_MAX_EXPONENT = 6

class FeedProtocolError extends Error {}

/**
 * A frame this parser refused, carrying the check that refused it. Every message thrown as
 * one is a literal written here: an upstream frame may echo credentials or private payloads,
 * so no value from a frame, and no schema message derived from one, may reach the client, the
 * logs, or the status detail. The class is what makes that structural — only a rejection we
 * wrote can have its message forwarded, and anything else collapses to a fixed description.
 */
class FeedFrameError extends Error {}


function streamRows(type: FeedType, values: JsonValue): JsonObject[] {
  const items = JsonArraySchema.parse(values)
  const fields = FIELDS[type]
  if (items.length % fields.length !== 0) throw new FeedFrameError('Malformed COMPACT row batch.')
  const rows: JsonObject[] = []
  for (let offset = 0; offset + fields.length <= items.length; offset += fields.length) {
    rows.push(Object.fromEntries(fields.map((field, index) => [field, items[offset + index]])))
  }
  return rows
}

function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined
}

function compactValueIsAbsent(value: JsonValue): boolean {
  return value === undefined || value === null || value === ''
}

/**
 * The downstream client socket surface the relay uses. Naming it separately keeps the
 * relay honest about what it touches on a hibernated socket, and lets a test drive it
 * with a plain object.
 */
export type FeedClientSocket = {
  close(code?: number, reason?: string): void
  /** Hibernation hands the attachment back undecoded; `socketSymbols` parses it. */
  deserializeAttachment(): JsonValue
  send(message: string): void
  /** Present on every accepted socket; optional so a test fake may omit it. */
  serializeAttachment?(attachment: JsonValue): void
}

export type FeedControlSocket = FeedClientSocket & {
  serializeAttachment(attachment: JsonValue): void
}

/**
 * The `DurableObjectState` surface the relay uses: socket acceptance, the hibernated
 * client list, the alarm, and background task tracking.
 */
export type FeedContext = {
  acceptWebSocket(socket: WebSocket): void
  getWebSockets(): FeedClientSocket[]
  storage: {
    deleteAlarm(): Promise<void>
    setAlarm(scheduledTime: number): Promise<void>
  }
  waitUntil(task: Promise<unknown>): void
}

function isoFromEpoch(epoch: number | undefined): string | undefined {
  if (epoch === undefined || epoch <= 0 || !Number.isSafeInteger(epoch)) return undefined
  const date = new Date(epoch)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

function eventTimestamp(row: JsonObject): string | undefined {
  return isoFromEpoch(jsonNumber(row.time ?? row.eventTime))
}

/**
 * Quote is the one subscribed event with no `time` of its own, and dxLink leaves its
 * `eventTime` at zero, so reading a quote like the others left every quote row without an
 * instant and condemned it as malformed. The instant that matters is the later of the two
 * sides the event does timestamp.
 */
function quoteTimestamp(row: JsonObject): string | undefined {
  const sides = [jsonNumber(row.bidTime), jsonNumber(row.askTime)].filter(isPresent)
  return sides.length ? isoFromEpoch(Math.max(...sides)) : undefined
}

function normalizedSymbol(value: JsonValue): string | undefined {
  const raw = TextFrameSchema.safeParse(value).data
  const symbol = raw?.split('{', 1)[0]?.toUpperCase()
  return EquitySymbolSchema.safeParse(symbol).data
}

/**
 * `undefined` means the row broke the contract and the connection cannot be trusted;
 * `null` means the row was well formed and simply carries no price to publish. A quote with
 * no bid or no ask is an ordinary market state — a name that is not quoted right now — and
 * conflating the two tore the whole feed down over one unquoted symbol.
 */
function eventFromRow(type: Exclude<FeedType, 'Greeks'>, row: JsonObject): LiveMarketEvent | null | undefined {
  const symbol = normalizedSymbol(row.eventSymbol)
  if (!symbol) return undefined
  if (type === 'Quote') {
    const rawBid = jsonNumber(row.bidPrice)
    const rawAsk = jsonNumber(row.askPrice)
    const bid = rawBid !== undefined && rawBid > 0 ? rawBid : undefined
    const ask = rawAsk !== undefined && rawAsk > 0 ? rawAsk : undefined
    const quotedAt = quoteTimestamp(row)
    // A side that has never been quoted carries no instant either, which is the same
    // ordinary silence as a missing price rather than a broken frame.
    if (bid === undefined || ask === undefined || bid > ask || quotedAt === undefined) return null
    return { type: 'market', symbol, price: (bid + ask) / 2, bid, ask, timestamp: quotedAt }
  }
  const timestamp = eventTimestamp(row)
  if (type === 'Trade') {
    // A trade without an instant is malformed; a candle decides for itself below, because it
    // can legitimately carry none.
    if (!timestamp) return undefined
    const price = jsonNumber(row.price)
    const change = jsonNumber(row.change)
    // A change field that is present but unreadable breaks the contract; a trade with no
    // positive price is simply nothing to publish yet.
    if (change === undefined && !compactValueIsAbsent(row.change)) return undefined
    if (price === undefined || price <= 0) return null
    const trade: LiveMarketEvent = { type: 'market', symbol, price, timestamp }
    if (change !== undefined) trade.change = change
    return trade
  }
  const candleClose = jsonNumber(row.close)
  // COMPACT encodes an absent numeric slot as null or an empty string, and for a candle those
  // slots are absent precisely when their value is zero — a quiet bucket carries no sequence
  // and no flags. Reading absence as damage tore the connection down on the first empty bucket
  // of every daily backfill, in a reconnect loop that also kept the year store empty.
  const sequence = jsonNumber(row.sequence) ?? (compactValueIsAbsent(row.sequence) ? 0 : undefined)
  const eventFlags = jsonNumber(row.eventFlags) ?? (compactValueIsAbsent(row.eventFlags) ? 0 : undefined)
  const candleTime = jsonNumber(row.time)
  // A candle with no instant at all is a frame with nothing to place; only a present-but-
  // unreadable instant breaks the contract.
  if (candleTime === undefined) return compactValueIsAbsent(row.time) ? null : undefined
  if (candleTime < 0 || !Number.isSafeInteger(candleTime)
    || sequence === undefined || sequence < 0 || !Number.isSafeInteger(sequence)
    || eventFlags === undefined || eventFlags < 0 || !Number.isSafeInteger(eventFlags)
    || (candleClose === undefined && !compactValueIsAbsent(row.close))) return undefined
  // A backfill reaching back days crosses buckets in which nothing traded, and dxFeed marks
  // snapshot boundaries the same way: no close, sometimes no instant at all. Those are ordinary
  // frames with nothing to publish. Reading them as a broken contract tore the whole feed down
  // over a quiet five minutes.
  if (!timestamp) return null
  if (!(eventFlags & DXLINK_REMOVE_EVENT) && !(candleClose && candleClose > 0)) return null
  return {
    type: 'market',
    symbol,
    candle: {
      time: candleTime,
      sequence,
      close: candleClose && candleClose > 0 ? candleClose : 0,
      eventFlags,
    },
    timestamp,
  }
}

/**
 * A single account-scoped relay: one secret-bearing DXLink socket, many authenticated
 * clients and RPC reads. All of the behaviour lives here, free of the Workers runtime
 * base class, so it can be driven with a stand-in `DurableObjectState`; `market-feed.ts`
 * supplies the Durable Object the platform instantiates.
 */
export class MarketFeedCore {
  private upstream?: WebSocket
  private connectInFlight?: Promise<void>
  private reconcileInFlight?: Promise<void>
  private reconcileNeeded = false
  private readonly subscribedByType = new Map<FeedType, Set<string>>()
  private openedChannels = new Set<number>()
  private configuredChannels = new Set<number>()
  private reconnectAttempt = 0
  private upstreamAuthorization: 'authorized' | 'awaiting' | 'initial-unauthorized' = 'awaiting'
  private keepalive?: ReturnType<typeof setInterval>
  private setupTimeout?: ReturnType<typeof setTimeout>
  private candleFromTime?: number
  private candles = new Map<string, CandlePoint[]>()
  private quoteToken?: { credentials: { token: string; url: string }; expiresAt: number }
  private readonly greekRequests = new OptionGreeksRequestRegistry()
  private readonly dailyRequests = new DailyCandleRequestRegistry()
  private feedState: MarketFeedStatus['state'] = 'connecting'

  constructor(
    private readonly ctx: FeedContext,
    private readonly env: AppEnv,
  ) {
    // Inbound sockets hibernate with the object; the outbound DXLink socket does not.
    if (ctx.getWebSockets().length) this.track(this.reconcile())
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 })
    let symbols: string[]
    try {
      symbols = parseRequestedSymbols(new URL(request.url))
    } catch {
      return new Response('Invalid market feed subscription', { status: 400 })
    }
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
    server.serializeAttachment({ seenAt: Date.now(), symbols } satisfies SocketAttachment)
    this.sendStatus(server, this.feedState)
    await this.reconcile()
    this.replayCandles(server, symbols)
    return new Response(null, { status: 101, webSocket: client })
  }

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
      await this.reconcile().catch((cause: unknown) => this.logError('MarketFeedCleanupFailed', toError(cause)))
    }
  }

  /**
   * Read a year of daily closes once, for the caller to cache. This is deliberately not a
   * streamed series: a daily bar changes once a session, so replaying it to every client on
   * every connect would cost far more than storing it.
   */
  async readDailyCandles(requestedSymbols: readonly string[]): Promise<DailyCandlesReadResult> {
    const symbols = parseMarketFeedSymbols(requestedSymbols)
    const lease = this.dailyRequests.register(symbols, DAILY_CANDLE_TIMEOUT_MS)
    try {
      await this.reconcile()
      const series = await lease.promise
      return DailyCandlesReadResultSchema.parse({
        asOf: new Date().toISOString(),
        series: [...series].map(([symbol, closes]) => ({ symbol, closes })),
        source: 'tastytrade-dxlink',
      })
    } finally {
      lease.release()
      await this.reconcile().catch((cause: unknown) => this.logError('MarketFeedCleanupFailed', toError(cause)))
    }
  }

  async webSocketMessage(socket: FeedControlSocket, message: string | ArrayBuffer): Promise<void> {
    let symbols: string[]
    try {
      const frame = TextFrameSchema.parse(message)
      const payload: JsonValue = JSON.parse(frame)
      if (HeartbeatFrameSchema.safeParse(payload).success) {
        this.markSeen(socket)
        return
      }
      const subscription = SubscriptionFrameSchema.parse(payload)
      symbols = [...new Set(subscription.symbols)]
    } catch {
      this.sendStatus(socket, 'degraded', 'Invalid subscription request')
      try { socket.close(1008, 'Invalid subscription request') } catch { /* Already closed. */ }
      return
    }
    socket.serializeAttachment({ seenAt: Date.now(), symbols } satisfies SocketAttachment)
    await this.reconcile()
  }

  async webSocketClose(): Promise<void> { await this.reconcile() }
  async webSocketError(): Promise<void> { await this.reconcile() }

  async alarm(): Promise<void> {
    await this.reconcile()
  }

  /**
   * Each socket is capped on its own, but the union across them was not, so enough readers on
   * different watchlists could put an unbounded number of subscriptions on the one upstream
   * connection. Sorting before the cut keeps the retained set stable across reconciles, so a
   * crowded relay does not churn subscriptions on and off every time a socket joins or leaves.
   */
  private downstreamSymbols(): Set<string> {
    const symbols = new Set<string>()
    for (const socket of this.ctx.getWebSockets()) {
      for (const symbol of this.socketSymbols(socket)) symbols.add(symbol)
    }
    if (symbols.size <= MAX_RELAYED_SYMBOLS) return symbols
    return new Set([...symbols].sort().slice(0, MAX_RELAYED_SYMBOLS))
  }

  private hasDemand(): boolean {
    return this.downstreamSymbols().size > 0
      || this.greekRequests.demandSymbols().size > 0
      || this.dailyRequests.demandSymbols().size > 0
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
      this.logError('MarketFeedConnectFailed', toError(error))
      this.broadcastStatus('degraded', 'Live market feed unavailable')
      if (this.hasDemand()) await this.scheduleReconnect()
    } finally {
      if (this.connectInFlight === attempt) this.connectInFlight = undefined
    }
  }

  /** Reuse a live token rather than spending a REST call on every reconnect. */
  private async credentials(): Promise<{ token: string; url: string }> {
    const cached = this.quoteToken
    if (cached && cached.expiresAt > Date.now()) return cached.credentials
    const credentials = await brokerApi().loadQuoteToken(this.env)
    this.quoteToken = { credentials, expiresAt: Date.now() + QUOTE_TOKEN_TTL_MS }
    return credentials
  }

  private async openUpstream(): Promise<void> {
    this.broadcastStatus('connecting')
    const credentials = await this.credentials()
    if (!this.hasDemand() || (this.upstream && this.upstream.readyState <= WebSocket.OPEN)) return
    this.candleFromTime = Date.now() - CANDLE_BACKFILL_MS
    const socket = new WebSocket(credentials.url)
    this.upstream = socket
    this.upstreamAuthorization = 'awaiting'
    this.openedChannels.clear()
    this.configuredChannels.clear()
    this.clearSetupTimeout()
    this.setupTimeout = setTimeout(() => {
      if (socket !== this.upstream || this.demandIsConfigured()) return
      this.track(this.closeUpstream(socket, 1013, 'Upstream setup timed out'))
    }, UPSTREAM_SETUP_TIMEOUT_MS)
    socket.addEventListener('open', () => this.track(this.handleUpstreamOpen(socket, credentials.token)))
    socket.addEventListener('message', (event) => this.track(this.handleUpstreamMessage(socket, event.data)))
    socket.addEventListener('close', () => this.track(this.handleUpstreamClose(socket)))
    socket.addEventListener('error', () => this.track(this.closeUpstream(socket, 1011, 'Upstream error')))
  }

  private async handleUpstreamOpen(socket: WebSocket, token: string): Promise<void> {
    if (socket !== this.upstream) {
      socket.close(1000, 'Superseded')
      return
    }
    await this.sendToUpstream(socket, {
      type: 'SETUP', channel: 0, keepaliveTimeout: 60, acceptKeepaliveTimeout: 60,
      version: '0.1-DXF-JS/0.3.0',
    })
    // dxLink reports its initial unauthenticated setup state independently of the
    // AUTH response. Send both client messages without waiting for that state so
    // the initial UNAUTHORIZED frame cannot race ahead of our token.
    await this.sendToUpstream(socket, { type: 'AUTH', channel: 0, token })
  }

  private async handleUpstreamMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (socket !== this.upstream) return
    try {
      const frame = TextFrameSchema.safeParse(raw)
      if (!frame.success) throw new FeedFrameError('Upstream feed frame was not text')
      const message = JsonObjectSchema.safeParse(JSON.parse(frame.data))
      if (!message.success) throw new FeedFrameError('Upstream feed frame was not a JSON object')
      await this.processUpstreamMessage(socket, message.data)
    } catch (error) {
      // Only a rejection written in this file may have its message forwarded. An upstream
      // frame may echo credentials or private payloads, so nothing derived from one — no
      // value, no schema message — reaches the client, the logs, or the status detail.
      let detail = 'Upstream feed frame did not match the expected shape'
      if (error instanceof FeedProtocolError || error instanceof FeedFrameError) detail = error.message
      else if (error instanceof SyntaxError) detail = 'Upstream feed frame was not JSON'
      await this.failProtocol(socket, detail)
    }
  }

  private async processUpstreamMessage(socket: WebSocket, message: JsonObject): Promise<void> {
    const messageType = TextFrameSchema.parse(message.type)
    const messageChannel = z.number().int().nonnegative().parse(message.channel)
    if (messageType === 'SETUP') {
      if (messageChannel !== 0) throw new FeedFrameError('Unexpected setup channel.')
      TextFrameSchema.min(1).parse(message.version)
      return
    }
    if (messageType === 'AUTH_STATE' && message.state === 'AUTHORIZED') {
      if (messageChannel !== 0) throw new FeedFrameError('Unexpected auth channel.')
      this.upstreamAuthorization = 'authorized'
      this.reconnectAttempt = 0
      if (this.keepalive) clearInterval(this.keepalive)
      for (const channel of Object.values(CHANNELS)) {
        if (!await this.sendToUpstream(socket, { type: 'CHANNEL_REQUEST', channel, service: 'FEED', parameters: { contract: 'AUTO' } })) return
      }
      // The object cannot hibernate while the upstream socket is open, so one interval can
      // carry both the upstream keepalive and the downstream liveness sweep.
      this.keepalive = setInterval(() => {
        this.track(this.sendToUpstream(socket, { type: 'KEEPALIVE', channel: 0 }).then(() => undefined))
        this.track(this.reapIdleSockets())
      }, CLIENT_HEARTBEAT_MS)
      return
    }
    if (messageType === 'AUTH_STATE') {
      if (messageChannel !== 0 || message.state !== 'UNAUTHORIZED') throw new FeedFrameError('Malformed auth state.')
      if (this.upstreamAuthorization === 'awaiting') {
        this.upstreamAuthorization = 'initial-unauthorized'
        // The token the handshake just used is the suspect; the next attempt buys a fresh one.
        this.quoteToken = undefined
        return
      }
      // Provider frames are untrusted and may echo credentials or private payloads.
      throw new FeedProtocolError('Upstream authorization failed')
    }
    if (messageType === 'CHANNEL_OPENED') {
      const type = FEED_TYPES.find((candidate) => CHANNELS[candidate] === messageChannel)
      if (!type) throw new FeedFrameError('Unexpected feed channel.')
      if (message.service !== 'FEED') throw new FeedFrameError('Unexpected channel service.')
      JsonObjectSchema.parse(message.parameters)
      const channel = messageChannel
      this.openedChannels.add(channel)
      this.configuredChannels.delete(channel)
      if (!await this.sendToUpstream(socket, {
        type: 'FEED_SETUP', channel, acceptAggregationPeriod: 0.25,
        acceptDataFormat: 'COMPACT', acceptEventFields: { [type]: [...FIELDS[type]] },
      })) return
      await this.reconcile()
      return
    }
    if (messageType === 'FEED_CONFIG') {
      const type = FEED_TYPES.find((candidate) => CHANNELS[candidate] === messageChannel)
      if (!type || !this.openedChannels.has(messageChannel)) throw new FeedFrameError('Unexpected feed config channel.')
      z.number().finite().nonnegative().parse(message.aggregationPeriod)
      if (message.dataFormat !== 'COMPACT') throw new FeedFrameError('Unexpected feed data format.')
      const eventFields = message.eventFields === undefined
        ? undefined
        : JsonObjectSchema.parse(message.eventFields)
      // dxLink answers a channel request with its own config before our FEED_SETUP applies,
      // and that first frame carries no eventFields because no layout is set yet. It
      // establishes nothing, so the channel stays unconfigured until a config arrives that
      // does carry the layout. That is the same state which keeps FEED_DATA refused, so an
      // unvalidated layout still cannot reach a subscriber, and the setup timeout still
      // reports a channel whose fields never arrive.
      if (eventFields === undefined && !this.configuredChannels.has(messageChannel)) return
      if (eventFields) {
        const fields = z.array(z.string()).parse(eventFields[type])
        if (fields.length !== FIELDS[type].length
          || fields.some((field, index) => field !== FIELDS[type][index])) {
          throw new FeedFrameError('Unexpected feed field configuration.')
        }
      }
      this.configuredChannels.add(messageChannel)
      if (this.demandIsConfigured()) {
        this.clearSetupTimeout()
        this.broadcastStatus('live')
      }
      return
    }
    if (messageType === 'FEED_DATA') {
      const type = FEED_TYPES.find((candidate) => CHANNELS[candidate] === messageChannel)
      if (!type || !this.configuredChannels.has(messageChannel)) throw new FeedFrameError('Unconfigured feed data channel.')
      this.broadcastFeedData(JsonArraySchema.parse(message.data), type)
      return
    }
    if (messageType === 'KEEPALIVE') {
      if (messageChannel !== 0) throw new FeedFrameError('Unexpected keepalive channel.')
      return
    }
    if (messageType === 'ERROR' || messageType === 'CHANNEL_CLOSED') {
      throw new FeedProtocolError(messageType === 'ERROR' ? 'Upstream feed error' : 'Upstream channel closed')
    }
    throw new FeedFrameError('Unexpected upstream message.')
  }

  /**
   * Keyed by the exact upstream streamer symbol, so the two candle periods stay distinct
   * subscriptions and a remove always names what the matching add named.
   */
  private desiredSubscriptions(type: FeedType): Map<string, JsonObject> {
    if (type !== 'Candle') {
      return new Map([...this.desiredSymbols(type)].map((symbol) => [symbol, { symbol, type }]))
    }
    const entries = new Map<string, JsonObject>()
    if (this.candleFromTime !== undefined) {
      for (const symbol of this.downstreamSymbols()) {
        const subscription = candleSubscription(symbol, this.candleFromTime, 'intraday')
        entries.set(subscription.symbol, subscription)
      }
    }
    const yearFromTime = Date.now() - YEAR_CANDLE_BACKFILL_MS
    for (const symbol of this.dailyRequests.demandSymbols()) {
      const subscription = candleSubscription(symbol, yearFromTime, 'daily')
      entries.set(subscription.symbol, subscription)
    }
    return entries
  }

  private async syncSubscriptions(socket: WebSocket): Promise<void> {
    for (const type of FEED_TYPES) {
      const channel = CHANNELS[type]
      if (!this.openedChannels.has(channel)) continue
      const next = this.desiredSubscriptions(type)
      const current = this.subscribedByType.get(type) ?? new Set<string>()
      const added = [...next.keys()].filter((symbol) => !current.has(symbol))
      const removed = [...current].filter((symbol) => !next.has(symbol))
      const frame: JsonObject = { type: 'FEED_SUBSCRIPTION', channel }
      if (added.length) frame.add = added.map((symbol) => next.get(symbol)!)
      if (removed.length) frame.remove = removed.map((symbol) => ({ symbol, type }))
      if ((added.length || removed.length) && !await this.sendToUpstream(socket, frame)) return
      this.subscribedByType.set(type, new Set(next.keys()))
    }
  }

  /** dxLink config is lazy, so idle event channels never hold a demanded feed in setup. */
  private demandIsConfigured(): boolean {
    return FEED_TYPES.every((type) => (
      this.desiredSymbols(type).size === 0 || this.configuredChannels.has(CHANNELS[type])
    ))
  }

  private broadcastFeedData(data: JsonValue[], channelType: FeedType): void {
    if (!data.length || data.length % 2 !== 0) throw new FeedFrameError('Malformed upstream feed envelope.')
    const batches: JsonObject[][] = []
    for (let offset = 0; offset < data.length; offset += 2) {
      const type = TextFrameSchema.parse(data[offset])
      if (type !== channelType) throw new FeedFrameError('Feed descriptor does not match its channel.')
      batches.push(streamRows(channelType, data[offset + 1]))
    }
    const rows = batches.flat()
    const type = channelType
    if (type === 'Greeks') {
      const events = rows.map((row) => optionGreeksFromRow(row)).filter(isPresent)
      if (events.length !== rows.length) throw new FeedFrameError('Malformed upstream Greeks row.')
      for (const event of events) this.greekRequests.accept(event)
      return
    }
    // One upstream channel carries both candle periods, so the year series is split off here
    // rather than merging into the intraday series that shares its symbol.
    const live = type === 'Candle' ? rows.filter((row) => !this.acceptDailyRow(row)) : rows
    const mapped = live.map((row) => eventFromRow(type, row))
    if (mapped.some((event) => event === undefined)) {
      throw new FeedFrameError(`Malformed upstream ${type} row.`)
    }
    const events = mapped.filter((event) => event !== null).filter(isPresent)
    for (const event of events) {
      this.cacheCandle(event)
      const serialized = JSON.stringify(event)
      for (const socket of this.ctx.getWebSockets()) {
        if (this.socketSymbols(socket).includes(event.symbol)) {
          try { socket.send(serialized) } catch { socket.close(1011, 'Delivery failed') }
        }
      }
    }
  }

  /** Returns true when the row belongs to the year series and has been consumed. */
  private acceptDailyRow(row: JsonObject): boolean {
    const streamerSymbol = TextFrameSchema.safeParse(row.eventSymbol).data
    if (!streamerSymbol || candleFeedPeriod(streamerSymbol) !== 'daily') return false
    const event = eventFromRow('Candle', row)
    if (event === undefined) throw new FeedFrameError('Malformed upstream Candle row.')
    if (event !== null && event.candle) this.dailyRequests.accept(event.symbol, event.candle)
    return true
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

  private replayCandles(socket: FeedClientSocket, symbols: readonly string[]): void {
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

  private async closeUpstream(socket: WebSocket, code: number, reason: string): Promise<void> {
    if (socket !== this.upstream) return
    try { socket.close(code, reason) } catch { /* Already closed. */ }
    await this.handleUpstreamClose(socket)
  }

  private async handleUpstreamClose(socket: WebSocket): Promise<void> {
    if (socket !== this.upstream) return
    this.upstream = undefined
    this.openedChannels.clear()
    this.configuredChannels.clear()
    this.subscribedByType.clear()
    // A half-delivered snapshot cannot be resumed across a reconnect; the resubscribe replays
    // it from the beginning, so the partial run is dropped rather than spliced onto the new one.
    this.dailyRequests.reset()
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
    const delay = Math.min(
      RECONNECT_MAX_DELAY_SECONDS,
      RECONNECT_BASE_DELAY_SECONDS * 2 ** Math.min(this.reconnectAttempt++, RECONNECT_MAX_EXPONENT),
    )
    await this.ctx.storage.setAlarm(Date.now() + delay * 1_000)
  }

  private async stopUpstream(code: number, reason: string): Promise<void> {
    if (this.keepalive) clearInterval(this.keepalive)
    this.keepalive = undefined
    const socket = this.upstream
    this.upstream = undefined
    this.openedChannels.clear()
    this.configuredChannels.clear()
    this.subscribedByType.clear()
    this.clearSetupTimeout()
    try { socket?.close(code, reason) } catch { /* Already closed. */ }
    await this.ctx.storage.deleteAlarm()
  }

  private async failProtocol(socket: WebSocket, detail: string): Promise<void> {
    if (socket !== this.upstream) return
    this.logError('MarketFeedProtocolError', detail)
    this.broadcastStatus('degraded', detail)
    await this.closeUpstream(socket, 1011, 'Upstream protocol failure')
    if (this.hasDemand()) this.broadcastStatus('degraded', detail)
  }

  /** Invalid hibernation state is closed instead of turning a subscribed client into no demand. */
  private markSeen(socket: FeedClientSocket): void {
    const attachment = SocketAttachmentSchema.safeParse(socket.deserializeAttachment())
    if (!attachment.success || !socket.serializeAttachment) return
    socket.serializeAttachment({ ...attachment.data, seenAt: Date.now() } satisfies SocketAttachment)
  }

  /**
   * Drop readers that have stopped announcing themselves, then reconcile: when the last one
   * goes, `hasDemand` turns false and the upstream connection closes with it. This is what
   * stops the relay streaming a market nobody is watching after a browser dies mid-connection.
   */
  private async reapIdleSockets(): Promise<void> {
    const now = Date.now()
    let reaped = false
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = SocketAttachmentSchema.safeParse(socket.deserializeAttachment())
      if (!attachment.success) continue
      const seenAt = attachment.data.seenAt
      // A socket accepted before this field existed is given one cycle to prove itself rather
      // than being closed for a silence that was never its fault.
      if (seenAt === undefined) {
        this.markSeen(socket)
        continue
      }
      if (now - seenAt <= CLIENT_IDLE_TIMEOUT_MS) continue
      try { socket.close(1000, 'Idle reader') } catch { /* Already closed. */ }
      reaped = true
    }
    if (reaped) await this.reconcile()
  }

  private socketSymbols(socket: FeedClientSocket): string[] {
    const attachment = SocketAttachmentSchema.safeParse(socket.deserializeAttachment())
    if (attachment.success) return [...new Set(attachment.data.symbols)]
    this.logError('MarketFeedAttachmentInvalid', 'Invalid socket subscription state')
    try { socket.close(1011, 'Invalid subscription state') } catch { /* Already closed. */ }
    return []
  }

  private broadcastStatus(state: MarketFeedStatus['state'], detail?: string): void {
    this.feedState = state
    for (const socket of this.ctx.getWebSockets()) this.sendStatus(socket, state, detail)
  }

  private sendStatus(socket: FeedClientSocket, state: MarketFeedStatus['state'], detail?: string): void {
    try {
      const status: MarketFeedStatus = { asOf: new Date().toISOString(), state, type: 'feed-status' }
      if (detail) status.detail = detail
      socket.send(JSON.stringify(status))
    } catch {
      try { socket.close(1011, 'Status delivery failed') } catch { /* Already closed. */ }
    }
  }

  private async sendToUpstream(socket: WebSocket, frame: JsonObject): Promise<boolean> {
    if (socket !== this.upstream || socket.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch (error) {
      this.logError('MarketFeedSendFailed', toError(error))
      try { socket.close(1011, 'Send failed') } catch { /* Already closed. */ }
      await this.handleUpstreamClose(socket)
      return false
    }
  }

  private track(task: Promise<void>): void {
    this.ctx.waitUntil(task.catch((cause: unknown) => this.logError('MarketFeedLifecycleFailed', toError(cause))))
  }

  private clearSetupTimeout(): void {
    if (this.setupTimeout) clearTimeout(this.setupTimeout)
    this.setupTimeout = undefined
  }

  /** Protocol failures carry a `detail` string rather than a thrown `Error`. */
  private logError(event: string, error: Error | string | undefined): void {
    console.error(event, error instanceof Error ? error.message : (error ?? 'UnknownError'))
  }
}
