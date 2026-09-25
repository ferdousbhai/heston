import { describe, expect, it } from 'vitest'

import {
  authenticateRequest,
  authorizePersonalRequest,
  canonicalHostRedirect,
  finalizeDocumentResponse,
  jsonPrivateRevalidate,
  jsonPublic,
} from '../src/server/http'
import { SPICE_DEPLOYMENT_ID_HEADER } from '../src/domain/deployment'
import { STORAGE_PURGE_COOKIE } from '../src/domain/storage-purge'

describe('canonical host redirect', () => {
  // Every host that routes here but is not the canonical origin: www, and the retired
  // heston.io and tryspice.xyz brands. Each is asserted explicitly.
  const OLD_HOSTS = ['www.spicy.trade', 'heston.io', 'www.heston.io', 'tryspice.xyz', 'www.tryspice.xyz']

  it('leaves the canonical host alone', () => {
    expect(canonicalHostRedirect(new Request('https://spicy.trade/'))).toBeUndefined()
    expect(canonicalHostRedirect(new Request('https://spicy.trade/privacy?from=x'))).toBeUndefined()
  })

  it.each(OLD_HOSTS)('308s %s to https://spicy.trade, preserving path and query', (host) => {
    const response = canonicalHostRedirect(new Request(`https://${host}/privacy?from=old&x=1`))
    expect(response?.status).toBe(308)
    expect(response?.headers.get('location')).toBe('https://spicy.trade/privacy?from=old&x=1')
    const root = canonicalHostRedirect(new Request(`https://${host}/`))
    expect(root?.status).toBe(308)
    expect(root?.headers.get('location')).toBe('https://spicy.trade/')
  })

  it.each(OLD_HOSTS)('refuses /mcp on %s instead of redirecting it into the anonymous tier', async (host) => {
    const response = canonicalHostRedirect(new Request(`https://${host}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'initialize' }),
      headers: { authorization: 'Bearer hst_example', 'content-type': 'application/json' },
      method: 'POST',
    }))
    expect(response?.status).toBe(404)
    expect(response?.headers.get('location')).toBeNull()
    expect(await response?.json()).toMatchObject({
      error: { message: expect.stringContaining('https://spicy.trade/mcp') },
      jsonrpc: '2.0',
    })
  })
})

describe('document response', () => {
  const html = () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html; charset=utf-8' } })

  it('asks a browser without the receipt to purge its storage, and leaves it a receipt', () => {
    const response = finalizeDocumentResponse(new Request('https://spicy.trade/'), html())
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.get(SPICE_DEPLOYMENT_ID_HEADER)).toBe('test')
    expect(response.headers.get('clear-site-data')).toBe('"cache", "storage"')
    expect(response.headers.get('set-cookie')).toBe(`${STORAGE_PURGE_COOKIE}=1; Max-Age=31536000; Path=/; SameSite=Lax; Secure`)
  })

  it('does not purge a browser that carries the current receipt', () => {
    const response = finalizeDocumentResponse(
      new Request('https://spicy.trade/', { headers: { cookie: `session=abc; ${STORAGE_PURGE_COOKIE}=1` } }),
      html(),
    )
    expect(response.headers.get('cache-control')).toBe('no-cache')
    expect(response.headers.has('clear-site-data')).toBe(false)
    expect(response.headers.has('set-cookie')).toBe(false)
  })

  it('purges again when the receipt is from an older generation', () => {
    const response = finalizeDocumentResponse(
      new Request('https://spicy.trade/', { headers: { cookie: `${STORAGE_PURGE_COOKIE}=0` } }),
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
    const response = finalizeDocumentResponse(new Request('https://spicy.trade/api/viewer'), json)
    expect(response).toBe(json)
    expect(response.headers.has('clear-site-data')).toBe(false)
  })
})

describe('private snapshot revalidation', () => {
  it('answers 304 when the owner already holds the current observation', async () => {
    const etag = 'W/"2026-09-18T15:49:52.243Z"'
    const matched = jsonPrivateRevalidate(
      new Request('https://spice.test/api/snapshot', { headers: { 'If-None-Match': etag } }),
      { ok: true },
      etag,
    )
    expect(matched.status).toBe(304)
    expect(matched.headers.get('etag')).toBe(etag)
    expect(matched.headers.get('cache-control')).toBe('private, no-cache')
    expect(await matched.text()).toBe('')
    const fresh = jsonPrivateRevalidate(new Request('https://spice.test/api/snapshot'), { ok: true }, etag)
    expect(fresh.status).toBe(200)
    await expect(fresh.json()).resolves.toEqual({ ok: true })
  })
})

describe('personal API authorization', () => {
  it('reports runtime authentication failure as temporary unavailability', async () => {
    // A session cookie is what reaches the runtime at all; without one the answer is a plain 401.
    const response = await authorizePersonalRequest(new Request('https://spice.test/api/snapshot', {
      headers: { cookie: '__Secure-better-auth.session_token=abc' },
    }), {})
    expect(response?.status).toBe(503)
    await expect(response?.json()).resolves.toEqual({ error: 'Authentication is temporarily unavailable' })
  })

  it('rejects an authenticated non-owner from owner-only personal routes', async () => {
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

  it('holds an owner write to the request\'s own origin', async () => {
    const owner = async () => ({ email: 'ferdousbd@gmail.com', id: 'owner-1', name: 'Owner' })
    const crossOrigin = await authorizePersonalRequest(new Request('https://spice.test/api/public-catalyst-refresh', {
      method: 'POST',
      headers: { Origin: 'https://attacker.test' },
    }), {}, true, owner)
    expect(crossOrigin?.status).toBe(403)
    const sameOrigin = await authorizePersonalRequest(new Request('https://spice.test/api/public-catalyst-refresh', {
      method: 'POST',
      headers: { Origin: 'https://spice.test' },
    }), {}, true, owner)
    expect(sameOrigin).toBeUndefined()
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

describe('public responses', () => {
  it('allows only a short shared cache window for account-free market data', () => {
    const response = jsonPublic({ status: 'ok' })
    expect(response.headers.get('cache-control')).toBe('public, max-age=30, s-maxage=60')
    expect(response.headers.get(SPICE_DEPLOYMENT_ID_HEADER)).toBe('test')
  })
})
