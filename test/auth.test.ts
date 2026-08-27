import { describe, expect, it } from 'vitest'

import { isOwnerEmail } from '../src/server/auth'

describe('authorized app identity', () => {
  it('grants owner authority only to the exact Google account', () => {
    expect(isOwnerEmail('ferdousbd@gmail.com')).toBe(true)
    expect(isOwnerEmail('FERDOUSBD@GMAIL.COM')).toBe(true)
    expect(isOwnerEmail('another@example.com')).toBe(false)
    expect(isOwnerEmail('ferdousbd@gmail.com.example.com')).toBe(false)
  })
})
