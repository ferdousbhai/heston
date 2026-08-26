import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonObjectSchema, type JsonValue } from '../src/domain/json-payload'

import { type AppEnv } from '../src/server/env'

import { MarketFeedCore, type FeedClientSocket, type FeedContext } from '../src/server/market-feed-core'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'

const tasty = stubBroker()

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

  emit(type: string, data?: string): void {
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

  constructor(private readonly clients: FeedClientSocket[]) {}

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

function downstream(symbols: string[]): FeedClientSocket {
  return {
    close: vi.fn(),
    deserializeAttachment: () => ({ symbols }),
    send: vi.fn(),
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
  tasty.loadEquityCandleFromTime.mockResolvedValue(1_786_000_000_000)
})

describe('MarketFeed option Greeks RPC', () => {
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
    socket.message({ type: 'SETUP' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 7 })
    await context.drain()

    socket.message({
      type: 'FEED_DATA',
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
    socket.message({ type: 'SETUP' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 3 })
    await context.drain()

    socket.message({
      type: 'FEED_DATA',
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

  it('does not expose provider-supplied protocol details to logs or clients', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'ERROR', message: 'private-provider-payload' })
    await context.drain()

    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('private-provider-payload')
    expect(JSON.stringify(vi.mocked(client.send).mock.calls)).not.toContain('private-provider-payload')
    expect(vi.mocked(client.send).mock.calls.some(([frame]) => frame.includes('Upstream feed error'))).toBe(true)
  })
})
