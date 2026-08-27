import { describe, expect, it } from 'vitest'

import { readBoundedJson, readBoundedText } from '../src/server/bounded-response'
import { boundedYahooFetch } from '../src/server/yahoo-finance-transport'

describe('bounded upstream response reader', () => {
  it('reads within the byte boundary and parses JSON', async () => {
    await expect(readBoundedJson(Response.json({ ok: true }), 100, 'Test')).resolves.toEqual({ ok: true })
  })

  it('rejects declared and streamed bodies before allocating beyond the limit', async () => {
    await expect(readBoundedText(new Response('small', {
      headers: { 'Content-Length': '1000' },
    }), 10, 'Test')).rejects.toThrow('response-too-large')

    await expect(readBoundedText(new Response('12345678901'), 10, 'Test'))
      .rejects.toThrow('response-too-large')
  })

  it('bounds Yahoo bodies before its client can buffer them', async () => {
    const oversized = new Response('x'.repeat(2_000_001))
    const fetchYahoo = boundedYahooFetch(async () => oversized)

    await expect(fetchYahoo('https://query1.finance.yahoo.com/test'))
      .rejects.toThrow('YahooFinance:response-too-large')
  })
})
