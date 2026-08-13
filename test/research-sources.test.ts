import { describe, expect, it, vi } from 'vitest'

import { collectResearchSources, parseResearchFeed } from '../src/server/research-sources'

describe('research sources', () => {
  it('parses RSS safely and rejects non-HTTPS links', () => {
    const xml = `
      <rss><channel>
        <item><title><![CDATA[Rates &amp; policy]]></title><link>https://example.gov/release</link><pubDate>Thu, 13 Aug 2026 13:00:00 GMT</pubDate></item>
        <item><title>Unsafe</title><link>http://example.gov/unsafe</link></item>
      </channel></rss>`
    expect(parseResearchFeed(xml, { name: 'Official', url: 'https://example.gov/feed.xml' })).toEqual([{
      source: 'Official',
      title: 'Rates & policy',
      url: 'https://example.gov/release',
      publishedAt: '2026-08-13T13:00:00.000Z',
    }])
  })

  it('keeps successful feeds when another publisher is unavailable', async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes('sec.gov')) return new Response('unavailable', { status: 503 })
      return new Response('<rss><channel><item><title>Policy update</title><link>https://www.federalreserve.gov/newsevents/pressreleases/test.htm</link></item></channel></rss>')
    }) as unknown as typeof fetch

    await expect(collectResearchSources({ fetcher })).resolves.toEqual([{
      source: 'Federal Reserve',
      title: 'Policy update',
      url: 'https://www.federalreserve.gov/newsevents/pressreleases/test.htm',
      publishedAt: undefined,
    }])
  })
})
