import { describe, expect, it, vi } from 'vitest'

import { collectRedditSources } from '../src/server/research-reddit'

describe('Reddit research source', () => {
  it('reviews bounded WSB bodies and top comments without fetching their links', async () => {
    const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('access_token')) return Response.json({ access_token: 'ephemeral-access' })
      if (url.includes('/hot?')) return Response.json({ data: { children: [
        { data: { title: 'Lower score', permalink: '/r/wallstreetbets/comments/one/test/', subreddit: 'wallstreetbets', score: 4, num_comments: 2, selftext: 'Small thesis', created_utc: 1_786_604_000 } },
        { data: { title: 'Higher score', permalink: '/r/wallstreetbets/comments/two/test/', subreddit: 'wallstreetbets', score: 200, num_comments: 18, selftext: 'Detailed thesis', is_self: false, url_overridden_by_dest: 'https://analysis.example/report', created_utc: 1_786_604_100 } },
      ] } })
      if (url.includes('.json?')) return Response.json([
        { data: { children: [] } },
        { data: { children: [
          { kind: 't1', data: { author: 'AutoModerator', body: 'Ignore me', score: 100, stickied: true } },
          { kind: 't1', data: { author: 'skeptic', body: 'Strong counterpoint https://evidence.example/counterpoint.', score: 15, stickied: false } },
          { kind: 't1', data: { author: 'bull', body: 'Primary confirmation', score: 30, stickied: false } },
        ] } },
      ])
      throw new Error(`Unexpected request: ${url}`)
    })

    const sources = await collectRedditSources({ clientId: 'id', clientSecret: 'secret' }, fetcher)
    expect(sources.map((source) => source.title)).toEqual(['Lower score', 'Higher score'])
    expect(sources[1]).toMatchObject({
      commentCount: 18,
      score: 200,
      url: 'https://www.reddit.com/r/wallstreetbets/comments/two/test/',
    })
    expect(sources[1]?.context).toContain('Detailed thesis')
    expect(sources[1]?.context).toContain('Primary confirmation')
    expect(sources[1]?.context).toContain('Strong counterpoint')
    expect(fetcher).not.toHaveBeenCalledWith('https://analysis.example/report', expect.anything())
    expect(sources[1]?.context).not.toContain('Ignore me')
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

  it('fails when the fixed WSB endpoint returns a cross-subreddit post', async () => {
    const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('access_token')) return Response.json({ access_token: 'ephemeral-access' })
      if (url.includes('/hot?')) return Response.json({ data: { children: [
        { data: { title: 'Wrong subreddit', permalink: '/r/stocks/comments/three/test/', subreddit: 'stocks', score: 100, num_comments: 20, selftext: '', created_utc: 1_786_604_200 } },
      ] } })
      throw new Error(`Unexpected request: ${url}`)
    })

    await expect(collectRedditSources({ clientId: 'id', clientSecret: 'secret' }, fetcher))
      .rejects.toThrow('cross-subreddit')
  })
})
