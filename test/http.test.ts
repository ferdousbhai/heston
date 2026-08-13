import { describe, expect, it } from 'vitest'

import { authorizePersonalRequest, canonicalHostRedirect, publicError } from '../src/server/http'

describe('canonical host redirect', () => {
  it('preserves the path and query when redirecting www to the canonical host', () => {
    const response = canonicalHostRedirect(new Request('https://www.tryspice.xyz/privacy?from=www'))
    expect(response?.status).toBe(308)
    expect(response?.headers.get('location')).toBe('https://tryspice.xyz/privacy?from=www')
    expect(canonicalHostRedirect(new Request('https://tryspice.xyz/'))).toBeUndefined()
  })
})

describe('personal API authorization', () => {
  it('keeps the complete demo usable without cloud credentials', async () => {
    await expect(authorizePersonalRequest(new Request('https://spice.test/api/snapshot'), { APP_MODE: 'demo' }))
      .resolves.toBeUndefined()
  })

  it('fails closed when live authentication is not configured', async () => {
    const response = await authorizePersonalRequest(new Request('https://spice.test/api/snapshot'), { APP_MODE: 'live' })
    expect(response?.status).toBe(503)
  })
})

describe('public errors', () => {
  it('explains why a broker preflight warning stopped placement', () => {
    const error = new Error('Tastytrade returned a preflight warning, so the order was not submitted: Review position effect')
    error.name = 'TastytradeOrderWarningError'
    expect(publicError(error)).toContain('order was not submitted')
  })
})
