import { describe, expect, it } from 'vitest'

import {
  authenticateRequest,
  authorizePersonalRequest,
  canonicalHostRedirect,
  finalizeDocumentResponse,
  jsonPrivateRevalidate,
  jsonPublic,
  ownerHttpFailure,
} from '../src/server/http'
import { BrokerageSubmissionUnknownError, TastytradeOrderWarningError } from '../src/server/brokerage'
import { OptionContractUnavailableError } from '../src/server/option-contract'
import { HESTON_DEPLOYMENT_ID_HEADER } from '../src/domain/deployment'
import { STORAGE_PURGE_COOKIE } from '../src/domain/storage-purge'

describe('canonical host redirect', () => {
  it('preserves the path and query when redirecting www to the canonical host', () => {
    const response = canonicalHostRedirect(new Request('https://www.heston.io/privacy?from=www'))
    expect(response?.status).toBe(308)
    expect(response?.headers.get('location')).toBe('https://heston.io/privacy?from=www')
    expect(canonicalHostRedirect(new Request('https://heston.io/'))).toBeUndefined()
  })

  it('redirects the retired tryspice.xyz brand, apex and www alike', () => {
    for (const host of ['tryspice.xyz', 'www.tryspice.xyz']) {
      const response = canonicalHostRedirect(new Request(`https://${host}/mcp?x=1`))
      expect(response?.status).toBe(308)
      expect(response?.headers.get('location')).toBe('https://heston.io/mcp?x=1')
    }
  })
})

describe('document response', () => {
  const html = () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })

  it('asks a browser without the receipt to purge its storage, and leaves it a receipt', () => {
    const response = finalizeDocumentResponse(new Request('https://heston.io/'), html())
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get(HESTON_DEPLOYMENT_ID_HEADER)).toBe('test')
    expect(response.headers.get('clear-site-data')).toBe('"cache", "storage"')
    expect(response.headers.get('set-cookie')).toBe(`${STORAGE_PURGE_COOKIE}=1; Max-Age=31536000; Path=/; SameSite=Lax; Secure`)
  })

  it('does not purge a browser that carries the current receipt', () => {
    const response = finalizeDocumentResponse(
      new Request('https://heston.io/', { headers: { cookie: `session=abc; ${STORAGE_PURGE_COOKIE}=1` } }),
      html(),
    )
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.has('clear-site-data')).toBe(false)
    expect(response.headers.has('set-cookie')).toBe(false)
  })

  it('purges again when the receipt is from an older generation', () => {
    const response = finalizeDocumentResponse(
      new Request('https://heston.io/', { headers: { cookie: `${STORAGE_PURGE_COOKIE}=0` } }),
      html(),
    )
    expect(response.headers.get('clear-site-data')).toBe('"cache", "storage"')
  })

  it('leaves the Secure attribute off the receipt where the local dev server could not set it', () => {
    const response = finalizeDocumentResponse(new Request('http://localhost:3000/'), html())
    expect(response.headers.get('set-cookie')).toBe(`${STORAGE_PURGE_COOKIE}=1; Max-Age=31536000; Path=/; SameSite=Lax`)
  })

  it('touches nothing but documents', () => {
    const json = new Response('{}', { headers: { 'content-type': 'application/json' } })
    const response = finalizeDocumentResponse(new Request('https://heston.io/api/viewer'), json)
    expect(response).toBe(json)
    expect(response.headers.has('clear-site-data')).toBe(false)
  })
})

describe('private snapshot revalidation', () => {
  it('answers 304 when the owner already holds the current observation', async () => {
    const etag = 'W/"2026-09-18T15:49:52.243Z"'
    const matched = jsonPrivateRevalidate(
      new Request('https://heston.test/api/snapshot', { headers: { 'If-None-Match': etag } }),
      { ok: true },
      etag,
    )
    expect(matched.status).toBe(304)
    expect(matched.headers.get('etag')).toBe(etag)
    expect(matched.headers.get('cache-control')).toBe('private, no-cache')
    expect(await matched.text()).toBe('')
    const fresh = jsonPrivateRevalidate(new Request('https://heston.test/api/snapshot'), { ok: true }, etag)
    expect(fresh.status).toBe(200)
    await expect(fresh.json()).resolves.toEqual({ ok: true })
  })
})

describe('personal API authorization', () => {
  it('reports runtime authentication failure as temporary unavailability', async () => {
    // A session cookie is what reaches the runtime at all; without one the answer is a plain 401.
    const response = await authorizePersonalRequest(new Request('https://heston.test/api/snapshot', {
      headers: { cookie: '__Secure-better-auth.session_token=abc' },
    }), {})
    expect(response?.status).toBe(503)
    await expect(response?.json()).resolves.toEqual({ error: 'Authentication is temporarily unavailable' })
  })

  it('rejects an authenticated non-owner from personal and trading routes', async () => {
    const response = await authorizePersonalRequest(
      new Request('https://heston.test/api/snapshot'),
      {},
      false,
      async () => ({ email: 'member@example.com', id: 'member-1', name: 'Member' }),
    )
    expect(response?.status).toBe(403)
    await expect(response?.json()).resolves.toEqual({ error: 'Owner access required' })
  })

  it('accepts only the exact owner identity on personal routes', async () => {
    const response = await authorizePersonalRequest(
      new Request('https://heston.test/api/snapshot'),
      {},
      false,
      async () => ({ email: 'ferdousbd@gmail.com', id: 'owner-1', name: 'Owner' }),
    )
    expect(response).toBeUndefined()
  })

  it('allows a signed-in member only through the same-origin authenticated boundary', async () => {
    const identity = async () => ({ email: 'member@example.com', id: 'member-1', name: 'Member' })
    const accepted = await authenticateRequest(new Request('https://heston.test/api/favorites', {
      method: 'POST',
      headers: { Origin: 'https://heston.test' },
    }), {}, true, identity)
    expect(accepted).toEqual({ identity: await identity() })

    const rejected = await authenticateRequest(new Request('https://heston.test/api/favorites', {
      method: 'POST',
      headers: { Origin: 'https://attacker.test' },
    }), {}, true, identity)
    expect('response' in rejected ? rejected.response.status : undefined).toBe(403)
  })
})

describe('owner route errors', () => {
  it('allows only typed or exact private failures through the boundary', () => {
    const error = new TastytradeOrderWarningError(['Review position effect'])
    expect(ownerHttpFailure(error, 409)).toEqual({ message: error.message, status: 409 })
    expect(ownerHttpFailure(new OptionContractUnavailableError('No matching expiry.'), 409)).toEqual({
      message: 'Requested option contract is not available. No matching expiry.',
      status: 409,
    })
    expect(ownerHttpFailure(new Error('InternalWatchlist:not-seeded'), 409)).toEqual({
      message: 'The internal watchlist has not been initialized',
      status: 409,
    })
    expect(ownerHttpFailure(new Error('provider body: account 123'), 502)).toEqual({
      message: 'The request could not be completed',
      status: 502,
    })
    const nameOnlyImpostor = new Error('private detail')
    nameOnlyImpostor.name = 'PortfolioRiskError'
    expect(ownerHttpFailure(nameOnlyImpostor, 409).message).toBe('The request could not be completed')
  })

  it('preserves ambiguous brokerage mutation handling regardless of route fallback', () => {
    const error = new BrokerageSubmissionUnknownError()
    expect(ownerHttpFailure(error, 409)).toEqual({ message: error.message, status: 502 })
  })
})

describe('public responses', () => {
  it('allows only a short shared cache window for account-free market data', () => {
    const response = jsonPublic({ status: 'ok' })
    expect(response.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=60')
    expect(response.headers.get(HESTON_DEPLOYMENT_ID_HEADER)).toBe('test')
  })
})
