import { describe, expect, it } from 'vitest'

import { parseTrustedProfileImage } from '../src/server/auth'

describe('Google profile image', () => {
  it('passes an https URL through unchanged', () => {
    const image = 'https://lh3.googleusercontent.com/a/ACg8ocJ=s96-c'
    expect(parseTrustedProfileImage(image)).toBe(image)
  })

  it('drops a missing, non-https, or unparseable value rather than repairing it', () => {
    expect(parseTrustedProfileImage(undefined)).toBeUndefined()
    expect(parseTrustedProfileImage(null)).toBeUndefined()
    expect(parseTrustedProfileImage('')).toBeUndefined()
    expect(parseTrustedProfileImage('http://lh3.googleusercontent.com/a/x')).toBeUndefined()
    expect(parseTrustedProfileImage('javascript:alert(1)')).toBeUndefined()
    expect(parseTrustedProfileImage('data:image/png;base64,AAAA')).toBeUndefined()
    expect(parseTrustedProfileImage('lh3.googleusercontent.com/a/x')).toBeUndefined()
  })
})
