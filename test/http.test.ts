import { describe, expect, it } from 'vitest'

import {
  authenticateRequest,
  authorizePersonalRequest,
  canonicalHostRedirect,
  jsonPublic,
  publicError,
} from '../src/server/http'

describe('canonical host redirect', () => {
  it('preserves the path and query when redirecting www to the canonical host', () => {
    const response = canonicalHostRedirect(new Request('https://www.tryspice.xyz/privacy?from=www'))
    expect(response?.status).toBe(308)
    expect(response?.headers.get('location')).toBe('https://tryspice.xyz/privacy?from=www')
    expect(canonicalHostRedirect(new Request('https://tryspice.xyz/'))).toBeUndefined()
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

describe('public errors', () => {
  it('explains why a broker preflight warning stopped placement', () => {
    const error = new Error('Tastytrade returned a preflight warning, so the order was not submitted: Review position effect')
    error.name = 'TastytradeOrderWarningError'
    expect(publicError(error)).toContain('order was not submitted')
  })
})

describe('public responses', () => {
  it('allows only a short shared cache window for account-free market data', () => {
    const response = jsonPublic({ status: 'ok' })
    expect(response.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=60')
  })
})
