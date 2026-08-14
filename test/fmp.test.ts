import { describe, expect, it, vi } from 'vitest'

import { createFmpClient, ResearchProviderError } from '../src/server/fmp'

function secret(value: string) {
  return { get: vi.fn().mockResolvedValue(value) }
}

describe('FMP client', () => {
  it('authenticates in a header and keeps credentials out of URLs and errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify([{ symbol: 'AAPL' }])))
    const client = createFmpClient({ FMP_API_KEY: secret('super-secret') }, fetcher)

    await expect(client.get('/historical-price-eod/dividend-adjusted', {
      symbol: 'AAPL',
      to: '2026-08-14',
    })).resolves.toEqual([{ symbol: 'AAPL' }])

    const [url, init] = fetcher.mock.calls[0]!
    expect(String(url)).toBe('https://financialmodelingprep.com/stable/historical-price-eod/dividend-adjusted?symbol=AAPL&to=2026-08-14')
    expect(String(url)).not.toContain('super-secret')
    expect(init.headers).toMatchObject({ Accept: 'application/json', apikey: 'super-secret' })
  })

  it('maps missing credentials and upstream statuses to stable error categories', async () => {
    const missing = createFmpClient({}, vi.fn())
    await expect(missing.get('/historical-price-eod/dividend-adjusted', {})).rejects.toMatchObject({
      code: 'configuration',
      provider: 'fmp',
    })

    const rateLimited = createFmpClient(
      { FMP_API_KEY: secret('secret') },
      vi.fn().mockResolvedValue(new Response(null, {
        headers: { 'x-request-id': 'request-123' },
        status: 429,
      })),
    )
    await expect(rateLimited.get('/historical-price-eod/dividend-adjusted', {})).rejects.toMatchObject({
      code: 'rate-limit',
      requestId: 'request-123',
      status: 429,
    })

    const invalidKey = createFmpClient(
      { FMP_API_KEY: secret('invalid') },
      vi.fn().mockResolvedValue(Response.json({ 'Error Message': 'Invalid API KEY.' })),
    )
    await expect(invalidKey.get('/historical-price-eod/dividend-adjusted', {})).rejects.toMatchObject({
      code: 'authentication',
      provider: 'fmp',
    })
  })

  it('rejects malformed success payloads without exposing the provider body', async () => {
    const client = createFmpClient(
      { FMP_API_KEY: secret('secret') },
      vi.fn().mockResolvedValue(new Response('{not-json')),
    )

    const error = await client.get('/historical-price-eod/dividend-adjusted', {}).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(ResearchProviderError)
    expect(error).toMatchObject({ code: 'invalid-response', provider: 'fmp' })
    expect(String(error)).not.toContain('not-json')
  })
})
