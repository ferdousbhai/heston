import { describe, expect, it, vi } from 'vitest'

import { collectRedditSources } from '../src/server/research-reddit'

describe('Reddit research source', () => {
  it('reviews bounded WSB bodies, top comments, and safe outbound text', async () => {
    const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('access_token')) return Response.json({ access_token: 'ephemeral-access' })
      if (url.includes('/hot?')) return Response.json({ data: { children: [
        { data: { title: 'Lower score', permalink: '/r/wallstreetbets/comments/one/test/', subreddit: 'wallstreetbets', score: 4, num_comments: 2, selftext: 'Small thesis', is_self: true, created_utc: 1_786_604_000 } },
        { data: { title: 'Higher score', permalink: '/r/wallstreetbets/comments/two/test/', subreddit: 'wallstreetbets', score: 200, num_comments: 18, selftext: 'Detailed thesis', is_self: false, url_overridden_by_dest: 'https://analysis.example/report', created_utc: 1_786_604_100 } },
        { data: { title: 'Wrong subreddit', permalink: '/r/stocks/comments/three/test/', subreddit: 'stocks', score: 100, num_comments: 20, created_utc: 1_786_604_200 } },
      ] } })
      if (url.includes('.json?')) return Response.json([
        { data: { children: [] } },
        { data: { children: [
          { data: { author: 'AutoModerator', body: 'Ignore me', score: 100, stickied: true } },
          { data: { author: 'skeptic', body: 'Strong counterpoint https://evidence.example/counterpoint.', score: 15 } },
          { data: { author: 'bull', body: 'Primary confirmation', score: 30 } },
        ] } },
      ])
      if (url === 'https://analysis.example/report') {
        return new Response('<html><style>ignore</style><body><h1>Channel checks</h1><p>Orders remain firm.</p></body></html>', {
          headers: { 'Content-Type': 'text/html' },
        })
      }
      if (url === 'https://evidence.example/counterpoint') {
        return new Response('<html><body><p>Cancellation risk is rising.</p></body></html>', {
          headers: { 'Content-Type': 'text/html' },
        })
      }
      throw new Error(`Unexpected request: ${url}`)
    })

    const sources = await collectRedditSources({ clientId: 'id', clientSecret: 'secret' }, fetcher)
    expect(sources.map((source) => source.title)).toEqual(['Higher score'])
    expect(sources[0]).toMatchObject({
      outbound: { label: 'analysis.example', url: 'https://analysis.example/report' },
      source: 'Reddit · r/wallstreetbets',
      url: 'https://www.reddit.com/r/wallstreetbets/comments/two/test/',
    })
    expect(sources[0]?.context).toContain('Detailed thesis')
    expect(sources[0]?.context).toContain('Primary confirmation')
    expect(sources[0]?.context).toContain('Strong counterpoint')
    expect(sources[0]?.context).toContain('Orders remain firm')
    expect(sources[0]?.context).toContain('Cancellation risk is rising')
    expect(sources[0]?.linkedPages?.map((link) => link.url)).toEqual([
      'https://analysis.example/report',
      'https://evidence.example/counterpoint',
    ])
    expect(sources[0]?.context).not.toContain('Ignore me')
    expect(JSON.stringify(sources)).not.toContain('secret')
  })

  it('fails when a successful Reddit listing has an invalid envelope', async () => {
    const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('access_token')) return Response.json({ access_token: 'ephemeral-access' })
      if (url.includes('/hot?')) return Response.json({ data: { children: 'provider-shape-changed' } })
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(collectRedditSources({ clientId: 'id', clientSecret: 'secret' }, fetcher))
      .rejects.toThrow('Reddit listing returned an invalid response')
  })
})
