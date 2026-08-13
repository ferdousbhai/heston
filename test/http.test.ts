import { describe, expect, it } from 'vitest'

import { authorizePersonalRequest } from '../src/server/http'

describe('personal API authorization', () => {
  it('keeps the complete demo usable without cloud credentials', async () => {
    await expect(authorizePersonalRequest(new Request('https://spice.test/api/snapshot'), { APP_MODE: 'demo' }))
      .resolves.toBeUndefined()
  })

  it('fails closed when a live Access verifier is not configured', async () => {
    const response = await authorizePersonalRequest(new Request('https://spice.test/api/snapshot'), { APP_MODE: 'live' })
    expect(response?.status).toBe(503)
  })
})
