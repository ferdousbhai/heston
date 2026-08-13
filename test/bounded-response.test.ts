import { describe, expect, it } from 'vitest'

import { readBoundedJson, readBoundedText } from '../src/server/bounded-response'

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
})
