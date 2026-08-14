import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type AppEnv } from '../src/server/env'

const tasty = vi.hoisted(() => ({
  loadEquityCandleFromTime: vi.fn(),
  loadQuoteToken: vi.fn(),
}))

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: DurableObjectState
    env: AppEnv

    constructor(ctx: DurableObjectState, env: AppEnv) {
      this.ctx = ctx
      this.env = env
    }
  },
}))

vi.mock('../src/server/tastytrade', () => tasty)

import { MarketFeed } from '../src/server/market-feed'

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

  message(payload: unknown): void {
    this.emit('message', JSON.stringify(payload))
  }

  emit(type: string, data?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

class FakeContext {
  readonly blockConcurrencyWhile = vi.fn()
  readonly deleteAlarm = vi.fn(async () => undefined)
  readonly setAlarm = vi.fn(async () => undefined)
  readonly tasks: Promise<unknown>[] = []
  readonly storage = { deleteAlarm: this.deleteAlarm, setAlarm: this.setAlarm }

  constructor(private readonly clients: WebSocket[]) {}

  getWebSockets(): WebSocket[] {
    return this.clients
  }

  waitUntil(task: Promise<unknown>): void {
    this.tasks.push(task)
  }

  async drain(): Promise<void> {
    while (this.tasks.length) await Promise.all(this.tasks.splice(0))
  }
}

function downstream(symbols: string[]): WebSocket {
  return {
    deserializeAttachment: () => ({ symbols }),
    send: vi.fn(),
  } as unknown as WebSocket
}

function liveEnvironment(): AppEnv {
  const secret = { get: vi.fn() } as unknown as SecretsStoreSecret
  return {
    TASTYTRADE_CLIENT_SECRET: secret,
    TASTYTRADE_REFRESH_TOKEN: secret,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeEach(() => {
  vi.clearAllMocks()
  FakeUpstreamWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeUpstreamWebSocket)
  tasty.loadQuoteToken.mockResolvedValue({ token: 'quote-token', url: 'wss://streamer.test' })
  tasty.loadEquityCandleFromTime.mockResolvedValue(1_786_000_000_000)
})

describe('MarketFeed option Greeks RPC', () => {
  it('single-flights concurrent reads, completes both, unsubscribes, and ignores stale close callbacks', async () => {
    const context = new FakeContext([downstream(['SPY'])])
    const feed = new MarketFeed(context as unknown as DurableObjectState, liveEnvironment())
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
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
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

  it('reconnects when the upstream never completes setup', async () => {
    vi.useFakeTimers()
    const context = new FakeContext([downstream(['SPY'])])
    new MarketFeed(context as unknown as DurableObjectState, liveEnvironment())
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeUpstreamWebSocket.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(15_000)
    await context.drain()
    expect(FakeUpstreamWebSocket.instances[0]?.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
    expect(context.setAlarm).toHaveBeenCalled()
    vi.useRealTimers()
  })
})
