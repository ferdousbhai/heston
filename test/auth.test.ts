import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { configureAuth, isOwnerEmail, mcpResourceIdentifier } from '../src/server/auth'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

describe('authorized app identity', () => {
  it('grants owner authority only to the exact Google account', () => {
    expect(isOwnerEmail('ferdousbd@gmail.com')).toBe(true)
    expect(isOwnerEmail('FERDOUSBD@GMAIL.COM')).toBe(true)
    expect(isOwnerEmail('another@example.com')).toBe(false)
    expect(isOwnerEmail('ferdousbd@gmail.com.example.com')).toBe(false)
  })
})

describe('MCP authorization server', () => {
  /*
   * Adding the OAuth provider changes the auth surface the whole site signs in through, and the
   * discovery documents are the only thing standing between a client and an unusable 401. Both
   * are exercised against the real migration schema rather than a stub, because a missing table
   * is exactly the failure this would otherwise ship.
   */
  async function authFor(store: SqliteD1Store) {
    return configureAuth(
      store.database,
      'https://tryspice.xyz',
      'test-secret-that-is-long-enough-32',
      'google-client-id',
      'google-client-secret',
    )
  }

  it('publishes protected-resource metadata bound to the MCP endpoint', async () => {
    const store = await migrationStore()
    try {
      const auth = await authFor(store)
      // Served at the ORIGIN, not under the auth base path -- unlike the authorization-server
      // metadata, which is only under it. The two are asymmetric, a client fetches both from the
      // root, and a 404 on either reads as "this server has no OAuth", so both are pinned.
      const response = await auth.handler(new Request(
        'https://tryspice.xyz/.well-known/oauth-protected-resource/mcp',
      ))
      expect(response.status).toBe(200)
      const body = z.object({
        authorization_servers: z.array(z.string()).min(1),
        resource: z.string(),
      }).parse(await response.json())
      // The audience every issued token is bound to. It must be the endpoint, not the origin.
      expect(body.resource).toBe(mcpResourceIdentifier('https://tryspice.xyz'))
    } finally {
      store.close()
    }
  })

  it('advertises a registration endpoint, since MCP clients register themselves', async () => {
    const store = await migrationStore()
    try {
      const auth = await authFor(store)
      const response = await auth.handler(new Request(
        'https://tryspice.xyz/api/auth/.well-known/oauth-authorization-server',
      ))
      expect(response.status).toBe(200)
      const body = z.object({
        authorization_endpoint: z.string(),
        registration_endpoint: z.string(),
        token_endpoint: z.string(),
      }).parse(await response.json())
      // Without dynamic client registration a client cannot obtain credentials at all, and the
      // endpoint is only advertised when it is explicitly enabled.
      expect(body.registration_endpoint).toContain('/oauth2/register')
      expect(body.authorization_endpoint).toContain('/oauth2/authorize')
    } finally {
      store.close()
    }
  })

  it('still serves the Google sign-in the site depends on', async () => {
    const store = await migrationStore()
    try {
      const auth = await authFor(store)
      const response = await auth.handler(new Request('https://tryspice.xyz/api/auth/sign-in/social', {
        body: JSON.stringify({ callbackURL: '/', provider: 'google' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }))
      // A redirect URL back to Google is the whole point; anything else means the provider stack
      // broke the flow the site's own sign-in button uses.
      expect(response.status).toBe(200)
      const body = z.object({ url: z.string() }).parse(await response.json())
      expect(body.url).toContain('accounts.google.com')
    } finally {
      store.close()
    }
  })
})
