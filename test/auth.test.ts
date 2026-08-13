import { describe, expect, it } from 'vitest'

import { isAuthorizedEmail } from '../src/server/auth'

describe('authorized app identity', () => {
  it('only accepts the temporary owner allowlist entry', () => {
    expect(isAuthorizedEmail('ferdousbd@gmail.com')).toBe(true)
    expect(isAuthorizedEmail('FERDOUSBD@GMAIL.COM')).toBe(true)
    expect(isAuthorizedEmail('another@example.com')).toBe(false)
    expect(isAuthorizedEmail('ferdousbd@gmail.com.example.com')).toBe(false)
  })
})
