import { describe, expect, it } from 'vitest'

import { CitedSourceUrlSchema, HttpsSourceUrlSchema, MAX_CITED_SOURCE_URL_LENGTH } from '../src/domain/https-url'
import { citedPageKey } from '../src/server/research-url'

const UNCITABLE = [
  'https://reuters.com@evil.example/x',
  'https://user:pass@example.com/x',
  'https://127.0.0.1:8080/',
  'https://127.0.0.1/',
  'https://[::1]/',
  'https://example.com:8443/x',
  'http://example.com/x',
]

describe('cited page addresses', () => {
  it.each(UNCITABLE)('refuses %s as a citation and as a page key', (url) => {
    expect(CitedSourceUrlSchema.safeParse(url).success).toBe(false)
    expect(citedPageKey(url)).toBeUndefined()
  })

  it('admits a host-named https page on its default port', () => {
    expect(CitedSourceUrlSchema.parse('https://www.reuters.com/markets/x')).toBe('https://www.reuters.com/markets/x')
    expect(CitedSourceUrlSchema.safeParse('https://www.reuters.com:443/markets/x').success).toBe(true)
    expect(citedPageKey('https://www.reuters.com/markets/x?utm_source=a#top')).toBe('https://www.reuters.com/markets/x')
  })

  it('keeps the legacy read to its https rule alone', () => {
    expect(HttpsSourceUrlSchema.safeParse('https://127.0.0.1:8080/').success).toBe(true)
  })

  it('refuses a page key whose canonical form leaves the envelope', () => {
    // Inside the envelope as given, but each raw character serializes percent-encoded.
    const raw = `https://example.com/${'é'.repeat(MAX_CITED_SOURCE_URL_LENGTH / 2)}`
    expect(raw.length).toBeLessThanOrEqual(MAX_CITED_SOURCE_URL_LENGTH)
    expect(citedPageKey(raw)).toBeUndefined()
    const fits = `https://example.com/${'é'.repeat(10)}`
    expect(CitedSourceUrlSchema.safeParse(citedPageKey(fits)).success).toBe(true)
  })
})
