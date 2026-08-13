import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('tastytrade OAuth boundary', () => {
  it('coalesces concurrent cold-start token refreshes', async () => {
    vi.resetModules()
    let releaseToken!: () => void
    const tokenGate = new Promise<void>((resolve) => { releaseToken = resolve })
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) {
        await tokenGate
        return Response.json({ access_token: 'shared-token', expires_in: 900 })
      }
      return Response.json({ data: { items: [] } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { tastyRequest } = await import('../src/server/tastytrade')
    const secret = { get: vi.fn().mockResolvedValue('secret') } as unknown as SecretsStoreSecret
    const env = { TASTYTRADE_CLIENT_SECRET: secret, TASTYTRADE_REFRESH_TOKEN: secret }

    const requests = Promise.all([
      tastyRequest(env, '/one'),
      tastyRequest(env, '/two'),
      tastyRequest(env, '/three'),
    ])
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    releaseToken()
    await requests

    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/oauth/token'))).toHaveLength(1)
    const tokenInit = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/oauth/token'))?.[1]
    expect(tokenInit?.signal).toBeInstanceOf(AbortSignal)
    const apiCalls = fetchMock.mock.calls.filter(([input]) => !String(input).endsWith('/oauth/token'))
    expect(apiCalls).toHaveLength(3)
    expect(apiCalls.every(([, init]) => new Headers(init?.headers).get('Authorization') === 'Bearer shared-token')).toBe(true)
  })

  it('redacts account identifiers from API errors', async () => {
    vi.resetModules()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/oauth/token')
      ? Response.json({ access_token: 'token', expires_in: 900 })
      : new Response('', { status: 404 })))
    const { tastyRequest } = await import('../src/server/tastytrade')
    const secret = { get: async () => 'secret' } as SecretsStoreSecret

    await expect(tastyRequest({
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    }, '/accounts/SECRET123/orders')).rejects.toThrow('/accounts/[redacted]/orders')
  })
})
