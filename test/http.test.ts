import { describe, expect, it } from 'vitest'

import {
  authenticateRequest,
  authorizePersonalRequest,
  canonicalHostRedirect,
  finalizeDocumentResponse,
  jsonPublic,
  ownerHttpFailure,
} from '../src/server/http'
import { BrokerageSubmissionUnknownError, TastytradeOrderWarningError } from '../src/server/brokerage'
import { OptionContractUnavailableError } from '../src/server/option-contract'
import { SPICE_DEPLOYMENT_ID_HEADER } from '../src/domain/deployment'
import { STORAGE_PURGE_COOKIE } from '../src/domain/storage-purge'

describe('canonical host redirect', () => {
  it('preserves the path and query when redirecting www to the canonical host', () => {
    const response = canonicalHostRedirect(new Request('https://www.tryspice.xyz/privacy?from=www'))
    expect(response?.status).toBe(308)
    expect(response?.headers.get('location')).toBe('https://tryspice.xyz/privacy?from=www')
    expect(canonicalHostRedirect(new Request('https://tryspice.xyz/'))).toBeUndefined()
  })
})

describe('document response', () => {
  const html = () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })

  it('asks a browser without the receipt to purge its storage, and leaves it a receipt', () => {
    const response = finalizeDocumentResponse(new Request('https://tryspice.xyz/'), html())
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get(SPICE_DEPLOYMENT_ID_HEADER)).toBe('test')
    expect(response.headers.get('clear-site-data')).toBe('"cache", "storage"')
    expect(response.headers.get('set-cookie')).toBe(`${STORAGE_PURGE_COOKIE}=1; Max-Age=31536000; Path=/; SameSite=Lax; Secure`)
  })

  it('does not purge a browser that carries the current receipt', () => {
    const response = finalizeDocumentResponse(
      new Request('https://tryspice.xyz/', { headers: { cookie: `session=abc; ${STORAGE_PURGE_COOKIE}=1` } }),
      html(),
    )
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.has('clear-site-data')).toBe(false)
    expect(response.headers.has('set-cookie')).toBe(false)
  })

  it('purges again when the receipt is from an older generation', () => {
    const response = finalizeDocumentResponse(
      new Request('https://tryspice.xyz/', { headers: { cookie: `${STORAGE_PURGE_COOKIE}=0` } }),
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
    const response = finalizeDocumentResponse(new Request('https://tryspice.xyz/api/viewer'), json)
    expect(response).toBe(json)
    expect(response.headers.has('clear-site-data')).toBe(false)
  })
})

describe('personal API authorization', () => {
  it('reports runtime authentication failure as temporary unavailability', async () => {
    const response = await authorizePersonalRequest(new Request('https://spice.test/api/snapshot'), {})
    expect(response?.status).toBe(503)
    await expect(response?.json()).resolves.toEqual({ error: 'Authentication is temporarily unavailable' })
  })

  it('rejects an authenticated non-owner from personal and trading routes', async () => {
    const response = await authorizePersonalRequest(
      new Request('https://spice.test/api/snapshot'),
      {},
      false,
      async () => ({ email: 'member@example.com', id: 'member-1', name: 'Member' }),
    )
    expect(response?.status).toBe(403)
    await expect(response?.json()).resolves.toEqual({ error: 'Owner access required' })
  })

  it('accepts only the exact owner identity on personal routes', async () => {
    const response = await authorizePersonalRequest(
      new Request('https://spice.test/api/snapshot'),
      {},
      false,
      async () => ({ email: 'ferdousbd@gmail.com', id: 'owner-1', name: 'Owner' }),
    )
    expect(response).toBeUndefined()
  })

  it('allows a signed-in member only through the same-origin authenticated boundary', async () => {
    const identity = async () => ({ email: 'member@example.com', id: 'member-1', name: 'Member' })
    const accepted = await authenticateRequest(new Request('https://spice.test/api/favorites', {
      method: 'POST',
      headers: { Origin: 'https://spice.test' },
    }), {}, true, identity)
    expect(accepted).toEqual({ identity: await identity() })

    const rejected = await authenticateRequest(new Request('https://spice.test/api/favorites', {
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
    expect(response.headers.get(SPICE_DEPLOYMENT_ID_HEADER)).toBe('test')
  })
})
