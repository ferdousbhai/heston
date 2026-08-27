import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubBrokerGate } from './broker-stub'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('tastytrade OAuth boundary', () => {
  it('acquires, renews, and releases the durable mutation lease around a broker sequence', async () => {
    vi.resetModules()
    const { withBrokerMutationLease } = await import('../src/server/tastytrade')
    const brokerGate = stubBrokerGate()
    const operation = vi.fn(async (lease: { renew(): Promise<void> }) => {
      await lease.renew()
      return 'done'
    })

    await expect(withBrokerMutationLease({ BROKER_GATE: brokerGate.namespace }, operation)).resolves.toBe('done')

    expect(brokerGate.gate.acquireMutation).toHaveBeenCalledTimes(1)
    expect(brokerGate.gate.renewMutation).toHaveBeenCalledWith('mutation-token')
    expect(brokerGate.gate.releaseMutation).toHaveBeenCalledWith('mutation-token')
  })

  it('releases the durable mutation lease when the broker sequence fails', async () => {
    vi.resetModules()
    const { withBrokerMutationLease } = await import('../src/server/tastytrade')
    const brokerGate = stubBrokerGate()

    await expect(withBrokerMutationLease({ BROKER_GATE: brokerGate.namespace }, async () => {
      throw new Error('failed before mutation')
    })).rejects.toThrow('failed before mutation')

    expect(brokerGate.gate.releaseMutation).toHaveBeenCalledWith('mutation-token')
  })

  it('does not share pending token-refresh I/O across Worker request contexts', async () => {
    vi.resetModules()
    let releaseToken!: () => void
    const tokenGate = new Promise<void>((resolve) => { releaseToken = resolve })
    let tokenNumber = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) {
        tokenNumber++
        const token = `request-token-${tokenNumber}`
        await tokenGate
        return Response.json({ access_token: token, expires_in: 900 })
      }
      return Response.json({ data: { items: [] } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { tastyRequest } = await import('../src/server/tastytrade')
    const secret: SecretsStoreSecret = { get: vi.fn().mockResolvedValue('secret') }
    const brokerGate = stubBrokerGate()
    const env = {
      BROKER_GATE: brokerGate.namespace,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    }

    const requests = Promise.all([
      tastyRequest(env, '/one'),
      tastyRequest(env, '/two'),
      tastyRequest(env, '/three'),
    ])
    await vi.waitFor(() => expect(
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/oauth/token')),
    ).toHaveLength(3))
    releaseToken()
    await requests

    const tokenCalls = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/oauth/token'))
    expect(tokenCalls).toHaveLength(3)
    expect(tokenCalls.every(([, init]) => init?.signal instanceof AbortSignal)).toBe(true)
    const apiCalls = fetchMock.mock.calls.filter(([input]) => !String(input).endsWith('/oauth/token'))
    expect(apiCalls).toHaveLength(3)
    expect(brokerGate.gate.acquire).toHaveBeenCalledTimes(3)
    expect(new Set(apiCalls.map(([, init]) => new Headers(init?.headers).get('Authorization')))).toEqual(new Set([
      'Bearer request-token-1',
      'Bearer request-token-2',
      'Bearer request-token-3',
    ]))
  })

  it('fails closed before reading credentials when the request coordinator is unavailable', async () => {
    vi.resetModules()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { tastyRequest } = await import('../src/server/tastytrade')
    const secret: SecretsStoreSecret = { get: vi.fn().mockResolvedValue('secret') }

    await expect(tastyRequest({
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    }, '/market-time/equities/sessions/current')).rejects.toThrow('TastytradeCoordinatorUnavailable')

    expect(secret.get).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('redacts account identifiers from API errors', async () => {
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/oauth/token')
      ? Response.json({ access_token: 'token', expires_in: 900 })
      : new Response('', { status: 404 })))
    const { tastyRequest } = await import('../src/server/tastytrade')
    const secret: SecretsStoreSecret = { get: async () => 'secret' }
    const brokerGate = stubBrokerGate()

    await expect(tastyRequest({
      BROKER_GATE: brokerGate.namespace,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    }, '/accounts/SECRET123/orders')).rejects.toThrow('/accounts/[redacted]/orders')
  })
})
