import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonObjectSchema, type JsonValue } from '../src/domain/json-payload'

import { type AppEnv } from '../src/server/env'

import {
  MarketFeedCore,
  type FeedClientSocket,
  type FeedContext,
  type FeedControlSocket,
} from '../src/server/market-feed-core'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'

const tasty = stubBroker()

const GREEKS_FIELDS = [
  'eventSymbol', 'eventFlags', 'index', 'time', 'sequence', 'price',
  'volatility', 'delta', 'gamma', 'theta', 'rho', 'vega',
]
const QUOTE_FIELDS = [
  'eventSymbol', 'eventTime', 'sequence', 'timeNanoPart', 'bidTime', 'bidExchangeCode',
  'askTime', 'askExchangeCode', 'bidPrice', 'askPrice', 'bidSize', 'askSize',
]

const CANDLE_FIELDS = [
  'eventSymbol', 'eventTime', 'eventFlags', 'index', 'time', 'sequence', 'count', 'volume',
  'vwap', 'bidVolume', 'askVolume', 'impVolatility', 'openInterest', 'open', 'high', 'low', 'close',
]

const TRADE_FIELDS = [
  'eventSymbol', 'eventTime', 'time', 'timeNanoPart', 'sequence', 'exchangeCode',
  'dayId', 'tickDirection', 'extendedTradingHours', 'price', 'change', 'size',
  'dayVolume', 'dayTurnover',
]

type Listener = (event: { data?: unknown }) => void

class FakeUpstreamWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeUpstreamWebSocket[] = []

  readonly listeners = new Map<string, Listener[]>()
  readonly sent: string[] = []
  readyState = FakeUpstreamWebSocket.CONNECTING

  constructor(readonly url: string) {
    FakeUpstreamWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener])
  }

  send(frame: string): void {
    if (this.readyState !== FakeUpstreamWebSocket.OPEN) throw new Error('Socket is not open')
    this.sent.push(frame)
  }

  close(): void {
    this.readyState = FakeUpstreamWebSocket.CLOSED
    this.emit('close')
  }

  open(): void {
    this.readyState = FakeUpstreamWebSocket.OPEN
    this.emit('open')
  }

  message(payload: JsonValue): void {
    this.emit('message', JSON.stringify(payload))
  }

  emit(type: string, data?: string | ArrayBuffer): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

class FakeContext implements FeedContext {
  readonly acceptWebSocket = vi.fn()
  readonly blockConcurrencyWhile = vi.fn()
  readonly deleteAlarm = vi.fn(async () => undefined)
  readonly setAlarm = vi.fn(async () => undefined)
  readonly tasks: Promise<unknown>[] = []
  readonly storage = { deleteAlarm: this.deleteAlarm, setAlarm: this.setAlarm }

  constructor(readonly clients: FeedClientSocket[]) {}

  getWebSockets(): FeedClientSocket[] {
    return this.clients
  }

  waitUntil(task: Promise<unknown>): void {
    this.tasks.push(task)
  }

  async drain(): Promise<void> {
    while (this.tasks.length) await Promise.all(this.tasks.splice(0))
  }
}

function downstream(symbols: string[], seenAt = Date.now()): FeedClientSocket {
  let attachment: JsonValue = { seenAt, symbols }
  return {
    close: vi.fn(),
    deserializeAttachment: () => attachment,
    send: vi.fn(),
    serializeAttachment: vi.fn((next: JsonValue) => { attachment = next }),
  }
}

function controlSocket(symbols: string[]): FeedControlSocket {
  let attachment: JsonValue = { seenAt: Date.now(), symbols }
  return {
    close: vi.fn(),
    deserializeAttachment: () => attachment,
    send: vi.fn(),
    serializeAttachment: vi.fn((next: JsonValue) => { attachment = next }),
  }
}

function liveEnvironment(): AppEnv {
  const secret: SecretsStoreSecret = { get: vi.fn() }
  return {
    TASTYTRADE_CLIENT_SECRET: secret,
    TASTYTRADE_REFRESH_TOKEN: secret,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  resetBrokerApi()
})

beforeEach(() => {
  vi.clearAllMocks()
  setBrokerApi(tasty)
  FakeUpstreamWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeUpstreamWebSocket)
  tasty.loadQuoteToken.mockResolvedValue({ token: 'quote-token', url: 'wss://streamer.test' })
})

describe('MarketFeed option Greeks RPC', () => {
  it('rejects invalid initial and resubscribe requests without accepting a partial symbol list', async () => {
    const context = new FakeContext([])
    const feed = new MarketFeedCore(context, liveEnvironment())
    const initial = await feed.fetch(new Request(
      'https://spice.test/api/stream?symbols=SPY,../secret,NVDA',
      { headers: { Upgrade: 'websocket' } },
    ))
    expect(initial.status).toBe(400)
    expect(context.acceptWebSocket).not.toHaveBeenCalled()

    const client = controlSocket(['SPY'])
    await feed.webSocketMessage(client, JSON.stringify({ type: 'subscribe', symbols: ['NVDA', '../secret'] }))
    expect(client.serializeAttachment).not.toHaveBeenCalled()
    expect(client.close).toHaveBeenCalledWith(1008, 'Invalid subscription request')
    expect(vi.mocked(client.send).mock.calls.some(([frame]) => (
      JsonObjectSchema.parse(JSON.parse(frame)).state === 'degraded'
    ))).toBe(true)

    const oversized = controlSocket(['SPY'])
    await feed.webSocketMessage(oversized, JSON.stringify({
      type: 'subscribe',
      symbols: Array.from({ length: 101 }, (_, index) => `A${index}`),
    }))
    expect(oversized.serializeAttachment).not.toHaveBeenCalled()
    expect(oversized.close).toHaveBeenCalledWith(1008, 'Invalid subscription request')
  })

  it('stays visibly degraded when the quote token cannot be loaded', async () => {
    tasty.loadQuoteToken.mockRejectedValueOnce(new Error('quote-token-unavailable'))
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(tasty.loadQuoteToken).toHaveBeenCalledTimes(1))
    await context.drain()

    expect(FakeUpstreamWebSocket.instances).toHaveLength(0)
    expect(context.setAlarm).toHaveBeenCalled()
    expect(vi.mocked(client.send).mock.calls.some(([frame]) => {
      const status = JsonObjectSchema.parse(JSON.parse(frame))
      return status.type === 'feed-status' && status.state === 'degraded'
    })).toBe(true)
  })

  it('single-flights concurrent reads, completes both, unsubscribes, and ignores stale close callbacks', async () => {
    const context = new FakeContext([downstream(['SPY'])])
    const feed = new MarketFeedCore(context, liveEnvironment())
    expect(context.blockConcurrencyWhile).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(tasty.loadQuoteToken).toHaveBeenCalledTimes(1))

    const first = feed.readOptionGreeks(['.NVDA260814C250'])
    const second = feed.readOptionGreeks(['.NVDA260814C250'])
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))
    expect(tasty.loadQuoteToken).toHaveBeenCalledTimes(1)

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    expect(socket.sent.map((frame) => JsonObjectSchema.parse(JSON.parse(frame))).slice(0, 2))
      .toEqual([
        expect.objectContaining({ channel: 0, type: 'SETUP' }),
        { channel: 0, token: 'quote-token', type: 'AUTH' },
      ])
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 7, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 7, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Greeks: GREEKS_FIELDS },
    })
    await context.drain()

    socket.message({
      type: 'FEED_DATA',
      channel: 7,
      data: ['Greeks', [
        '.NVDA260814C250', 0, 0, 1_786_629_600_000, 1,
        3.2, 0.42, 0.5, 0.03, -0.04, 0.02, 0.12,
      ]],
    })
    await context.drain()
    const results = await Promise.all([first, second])
    expect(results[0].greeks).toEqual(results[1].greeks)
    expect(results[0].greeks[0]).toMatchObject({
      impliedVolatilityUnit: 'decimal_ratio',
      source: 'tastytrade-dxlink',
      streamerSymbol: '.NVDA260814C250',
    })

    const subscriptions = socket.sent
      .map((frame) => JsonObjectSchema.parse(JSON.parse(frame)))
      .filter((frame) => frame.type === 'FEED_SUBSCRIPTION' && frame.channel === 7)
    expect(subscriptions).toEqual([
      { add: [{ symbol: '.NVDA260814C250', type: 'Greeks' }], channel: 7, type: 'FEED_SUBSCRIPTION' },
      { channel: 7, remove: [{ symbol: '.NVDA260814C250', type: 'Greeks' }], type: 'FEED_SUBSCRIPTION' },
    ])

    socket.emit('error')
    await context.drain()
    await feed.alarm()
    expect(FakeUpstreamWebSocket.instances).toHaveLength(2)
    const reconnectAlarmCount = context.setAlarm.mock.calls.length
    socket.emit('close')
    await context.drain()
    expect(context.setAlarm).toHaveBeenCalledTimes(reconnectAlarmCount)

    FakeUpstreamWebSocket.instances[1]!.close()
    await context.drain()
  })

  it('does not turn an absent trade change into a false zero-percent move', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))
    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 3, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 3, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Trade: TRADE_FIELDS },
    })
    await context.drain()

    socket.message({
      type: 'FEED_DATA',
      channel: 3,
      data: ['Trade', [
        'SPY', 1_786_629_600_000, 1_786_629_600_000, null, 1, 'Q',
        1, 'Up', false, 700, null, 10, 1_000, 700_000,
      ]],
    })
    await context.drain()

    const marketFrame = vi.mocked(client.send).mock.calls
      .map(([frame]) => JsonObjectSchema.parse(JSON.parse(frame)))
      .find((frame) => frame.type === 'market')
    expect(marketFrame).toMatchObject({ price: 700, symbol: 'SPY', type: 'market' })
    expect(marketFrame).not.toHaveProperty('change')
    socket.close()
    await context.drain()
  })

  it('keeps the year series off the intraday chart while both ride one candle channel', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    const feed = new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))
    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 5, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 5, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Candle: CANDLE_FIELDS },
    })
    await context.drain()

    const yearRead = feed.readDailyCandles(['SPY'])
    await context.drain()
    const candleAdds = socket.sent
      .map((frame) => JsonObjectSchema.parse(JSON.parse(frame)))
      .filter((frame) => frame.type === 'FEED_SUBSCRIPTION' && frame.channel === 5)
      .flatMap((frame) => Array.isArray(frame.add) ? frame.add : [])
      .map((entry) => JsonObjectSchema.parse(entry).symbol)
    expect(candleAdds).toContain('SPY{=5m,tho=true}')
    expect(candleAdds).toContain('SPY{=d}')

    // One batch carrying both periods: the daily row is a complete snapshot (BEGIN | END).
    socket.message({
      type: 'FEED_DATA',
      channel: 5,
      data: ['Candle', [
        'SPY{=5m,tho=true}', 1_786_629_600_000, 0, 0, 1_786_629_600_000, 1, 1, 100,
        null, null, null, null, null, 699, 701, 698, 700,
        'SPY{=d}', 1_786_543_200_000, 0xC, 0, 1_786_543_200_000, 0, 1, 100,
        null, null, null, null, null, 690, 695, 689, 694,
      ]],
    })
    await context.drain()

    const year = await yearRead
    expect(year.series).toEqual([{ symbol: 'SPY', closes: [{ close: 694, sequence: 0, time: 1_786_543_200_000 }] }])

    const candleFrames = vi.mocked(client.send).mock.calls
      .map(([frame]) => JsonObjectSchema.parse(JSON.parse(frame)))
      .filter((frame) => frame.type === 'market' && frame.candle)
      .map((frame) => JsonObjectSchema.parse(frame.candle))
    expect(candleFrames.map((candle) => candle.close)).toEqual([700])

    socket.close()
    await context.drain()
  })

  it('drops a reader that stopped announcing itself and closes the upstream with it', async () => {
    vi.useFakeTimers()
    // The fake clock starts at the epoch, so pin a real instant before deriving a past one.
    vi.setSystemTime(new Date('2026-08-28T14:00:00.000Z'))
    // A browser that crashed or slept never sends a close frame, so its socket looks attached.
    const abandoned = downstream(['SPY'], Date.now() - 5 * 60_000)
    const context = new FakeContext([abandoned])
    const feed = new MarketFeedCore(context, liveEnvironment())
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    // The handshake has to finish, or the setup timeout closes the upstream before the sweep.
    const handshake = [
      [1, 'Quote', QUOTE_FIELDS],
      [3, 'Trade', TRADE_FIELDS],
      [5, 'Candle', CANDLE_FIELDS],
      [7, 'Greeks', GREEKS_FIELDS],
    ] as const
    for (const [channel, type, fields] of handshake) {
      socket.message({ type: 'CHANNEL_OPENED', channel, service: 'FEED', parameters: { contract: 'AUTO' } })
      await context.drain()
      socket.message({
        type: 'FEED_CONFIG', channel, aggregationPeriod: 0.25,
        dataFormat: 'COMPACT', eventFields: { [type]: fields },
      })
      await context.drain()
    }
    expect(socket.readyState).toBe(FakeUpstreamWebSocket.OPEN)

    // The sweep rides the keepalive interval; the socket is still attached, just silent.
    await vi.advanceTimersByTimeAsync(30_000)
    await context.drain()
    expect(abandoned.close).toHaveBeenCalledWith(1000, 'Idle reader')

    // The runtime retires a closed socket and reports it; that is what drops the last demand.
    context.clients.length = 0
    await feed.webSocketClose()
    await context.drain()
    expect(socket.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
    vi.useRealTimers()
  })

  it('keeps a reader that is still announcing itself', async () => {
    const live = controlSocket(['SPY'])
    const context = new FakeContext([live])
    const feed = new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    await feed.webSocketMessage(live, JSON.stringify({ type: 'heartbeat' }))

    // A heartbeat is liveness only: it must never be mistaken for a subscription change.
    expect(live.close).not.toHaveBeenCalled()
    expect(vi.mocked(live.serializeAttachment).mock.calls.at(-1)?.[0])
      .toMatchObject({ symbols: ['SPY'] })
    FakeUpstreamWebSocket.instances[0]!.close()
    await context.drain()
  })

  it('survives a quiet candle bucket instead of tearing the feed down', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))
    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 5, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 5, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Candle: CANDLE_FIELDS },
    })
    await context.drain()

    // A days-long backfill crosses buckets where nothing traded: no close, and a snapshot
    // boundary marker carries no instant either. Both must be survivable.
    socket.message({
      type: 'FEED_DATA',
      channel: 5,
      data: ['Candle', [
        'SPY{=5m,tho=true}', 1_786_629_600_000, 0, 0, 1_786_629_600_000, 1, 0, 0,
        null, null, null, null, null, null, null, null, null,
        'SPY{=5m,tho=true}', 0, 0x8, 0, 0, 0, 0, 0,
        null, null, null, null, null, null, null, null, null,
      ]],
    })
    await context.drain()

    expect(socket.readyState).toBe(FakeUpstreamWebSocket.OPEN)
    expect(vi.mocked(client.send).mock.calls.some(([frame]) => (
      JsonObjectSchema.parse(JSON.parse(frame)).state === 'degraded'
    ))).toBe(false)
    socket.close()
    await context.drain()
  })

  it('reconnects when the upstream never completes setup', async () => {
    vi.useFakeTimers()
    const context = new FakeContext([downstream(['SPY'])])
    new MarketFeedCore(context, liveEnvironment())
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeUpstreamWebSocket.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(15_000)
    await context.drain()
    expect(FakeUpstreamWebSocket.instances[0]?.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
    expect(context.setAlarm).toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('treats a second pre-authorization rejection as an invalid token', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' })
    await context.drain()
    expect(socket.readyState).toBe(FakeUpstreamWebSocket.OPEN)

    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' })
    await context.drain()
    expect(socket.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
    expect(vi.mocked(client.send).mock.calls.some(([frame]) => (
      JsonObjectSchema.parse(JSON.parse(frame)).detail === 'Upstream authorization failed'
    ))).toBe(true)
  })

  it('treats any rejection after authorization as terminal', async () => {
    const context = new FakeContext([downstream(['SPY'])])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' })
    await context.drain()

    expect(socket.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
  })

  it('does not expose provider-supplied protocol details to logs or clients', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'ERROR', channel: 0, message: 'private-provider-payload' })
    await context.drain()

    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('private-provider-payload')
    expect(JSON.stringify(vi.mocked(client.send).mock.calls)).not.toContain('private-provider-payload')
    expect(vi.mocked(client.send).mock.calls.some(([frame]) => frame.includes('Upstream feed error'))).toBe(true)
  })

  it('degrades and reconnects instead of dropping malformed upstream envelopes', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.emit('message', '{not-json')
    await context.drain()

    expect(socket.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
    expect(context.setAlarm).toHaveBeenCalled()
    expect(vi.mocked(client.send).mock.calls.some(([frame]) => {
      const status = JsonObjectSchema.parse(JSON.parse(frame))
      return status.type === 'feed-status'
        && status.state === 'degraded'
        && status.detail === 'Upstream feed frame was not JSON'
    })).toBe(true)
  })

  it('waits for the layout instead of failing on dxLink\'s own opening config', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 3, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    // dxLink's answer to the channel request: its own defaults, carrying no field layout.
    socket.message({ type: 'FEED_CONFIG', channel: 3, aggregationPeriod: 0.25, dataFormat: 'COMPACT' })
    await context.drain()

    expect(socket.readyState).toBe(FakeUpstreamWebSocket.OPEN)
    expect(vi.mocked(client.send).mock.calls.some(([sent]) => {
      const status = JsonObjectSchema.parse(JSON.parse(sent))
      return status.type === 'feed-status' && status.state === 'live'
    })).toBe(false)

    // The channel is not configured, so data on it is still refused rather than mapped
    // against a layout nobody validated.
    socket.message({
      type: 'FEED_DATA',
      channel: 3,
      data: ['Trade', ['SPY', 1_786_629_600_000, 1_786_629_600_000, null, 1, 'Q',
        1, 'Up', false, 700, null, 10, 1_000, 700_000]],
    })
    await context.drain()
    expect(vi.mocked(client.send).mock.calls.some(([sent]) => {
      const status = JsonObjectSchema.parse(JSON.parse(sent))
      return status.detail === 'Unconfigured feed data channel.'
    })).toBe(true)
  })

  it('publishes a quote from its own bid and ask instants, and stays up when unquoted', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 1, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 1, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Quote: QUOTE_FIELDS },
    })
    await context.drain()

    // dxLink leaves eventTime at zero on a quote, so a real one is only publishable if the
    // bid and ask instants are read instead.
    socket.message({
      type: 'FEED_DATA',
      channel: 1,
      data: ['Quote', ['SPY', 0, 1, null, 1_786_629_600_000, 'Q',
        1_786_629_599_000, 'Q', 699, 701, 10, 12]],
    })
    await context.drain()

    expect(socket.readyState).toBe(FakeUpstreamWebSocket.OPEN)
    const quote = vi.mocked(client.send).mock.calls
      .map(([sent]) => JsonObjectSchema.parse(JSON.parse(sent)))
      .find((frame) => frame.type === 'market')
    expect(quote).toMatchObject({
      symbol: 'SPY', bid: 699, ask: 701, price: 700,
      timestamp: new Date(1_786_629_600_000).toISOString(),
    })

    // A name that is simply not quoted right now is ordinary silence, not a broken frame.
    socket.message({
      type: 'FEED_DATA',
      channel: 1,
      data: ['Quote', ['SPY', 0, 2, null, 0, 'Q', 0, 'Q', 0, 0, 0, 0]],
    })
    await context.drain()

    expect(socket.readyState).toBe(FakeUpstreamWebSocket.OPEN)
    expect(vi.mocked(client.send).mock.calls.some(([sent]) => {
      const status = JsonObjectSchema.parse(JSON.parse(sent))
      return status.detail === 'Malformed upstream Quote row.'
    })).toBe(false)
  })

  // A refused frame used to report one generic string whatever refused it, which left a live
  // production failure undiagnosable. Each check now names itself without quoting the frame.
  it.each([
    ['a frame that is not text', new ArrayBuffer(4), 'Upstream feed frame was not text'],
    ['a message type it does not handle', '{"type":"NOPE","channel":0}', 'Unexpected upstream message.'],
    ['a keepalive off channel zero', '{"type":"KEEPALIVE","channel":3}', 'Unexpected keepalive channel.'],
  ])('names the check that refused %s', async (_name, frame, detail) => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.emit('message', frame)
    await context.drain()

    expect(vi.mocked(client.send).mock.calls.some(([sent]) => {
      const status = JsonObjectSchema.parse(JSON.parse(sent))
      return status.type === 'feed-status' && status.state === 'degraded' && status.detail === detail
    })).toBe(true)
  })

  it('validates a whole COMPACT batch before broadcasting any of its rows', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 3, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 3, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Trade: TRADE_FIELDS },
    })
    await context.drain()
    socket.message({
      type: 'FEED_DATA',
      channel: 3,
      // The second row's change is present but unreadable, so the layout itself is in doubt
      // and the sibling row cannot be trusted either, however well it happens to parse.
      data: ['Trade', [
        'SPY', 1_786_629_600_000, 1_786_629_600_000, null, 1, 'Q',
        1, 'Up', false, 700, 1, 10, 1_000, 700_000,
        'SPY', 1_786_629_600_100, 1_786_629_600_100, null, 2, 'Q',
        1, 'Up', false, 700, 'not-a-number', 10, 1_010, 707_000,
      ]],
    })
    await context.drain()

    expect(vi.mocked(client.send).mock.calls.every(([frame]) => (
      JsonObjectSchema.parse(JSON.parse(frame)).type !== 'market'
    ))).toBe(true)
    expect(socket.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
  })
})
