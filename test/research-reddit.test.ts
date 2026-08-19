import { describe, expect, it, vi } from 'vitest'

import { collectRedditSources } from '../src/server/research-reddit'

describe('Reddit research source', () => {
  it('uses OAuth credentials only for authentication and returns bounded source metadata', async () => {
    const fetcher: typeof fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('access_token')) return Response.json({ access_token: 'ephemeral-access' })
      return Response.json({ data: { children: [
        { data: { title: 'Untrusted URL', permalink: 'https://example.com/not-reddit', subreddit: 'options', score: 100, created_utc: 1_786_604_200 } },
        { data: { title: 'Lower score', permalink: '/r/options/comments/one/test/', subreddit: 'options', score: 4, created_utc: 1_786_604_000 } },
        { data: { title: 'Higher score', permalink: '/r/stocks/comments/two/test/', subreddit: 'stocks', score: 20, created_utc: 1_786_604_100 } },
      ] } })
    })

    const sources = await collectRedditSources({ clientId: 'id', clientSecret: 'secret' }, fetcher)
    expect(sources.map((source) => source.title)).toEqual(['Higher score', 'Lower score'])
    expect(sources[0]?.url).toBe('https://www.reddit.com/r/stocks/comments/two/test/')
    expect(JSON.stringify(sources)).not.toContain('secret')
  })
})
