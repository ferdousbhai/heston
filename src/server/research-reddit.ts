import { type ResearchSourceItem } from './research-contracts'

export interface RedditCredentials {
  clientId: string
  clientSecret: string
}

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? value as JsonRecord : {}
}

function redditUrl(value: string): string | undefined {
  try {
    const url = new URL(value, 'https://www.reddit.com')
    return url.protocol === 'https:' && url.hostname === 'www.reddit.com' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

export async function collectRedditSources(
  credentials: RedditCredentials,
  fetcher: typeof fetch = fetch,
): Promise<ResearchSourceItem[]> {
  const tokenResponse = await fetcher('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${credentials.clientId}:${credentials.clientSecret}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'SpiceMustFlow/0.1 personal-options-research',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(8_000),
  })
  if (!tokenResponse.ok) throw new Error(`Reddit OAuth returned ${tokenResponse.status}`)
  const token = record(await tokenResponse.json()).access_token
  if (typeof token !== 'string' || !token) throw new Error('Reddit OAuth returned no access token')

  const listingResponse = await fetcher('https://oauth.reddit.com/r/options+wallstreetbets+stocks/hot?limit=18&raw_json=1', {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'SpiceMustFlow/0.1 personal-options-research' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!listingResponse.ok) throw new Error(`Reddit listing returned ${listingResponse.status}`)
  const listing = record(await listingResponse.json())
  const children = record(listing.data).children
  if (!Array.isArray(children)) return []

  return children
    .map((child) => record(record(child).data))
    .flatMap((post) => {
      if (typeof post.title !== 'string' || typeof post.permalink !== 'string') return []
      const url = redditUrl(post.permalink)
      return url ? [{ post, url }] : []
    })
    .sort((left, right) => Number(right.post.score ?? 0) - Number(left.post.score ?? 0))
    .slice(0, 6)
    .map(({ post, url }) => {
      const published = new Date(Number(post.created_utc) * 1_000)
      return {
        source: `Reddit · r/${typeof post.subreddit === 'string' ? post.subreddit : 'markets'}`,
        title: String(post.title).slice(0, 240),
        url,
        publishedAt: Number.isNaN(published.valueOf()) ? undefined : published.toISOString(),
      }
    })
}
