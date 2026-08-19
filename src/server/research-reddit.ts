import { type ResearchSourceItem } from './research-contracts'
import { readBoundedJson } from './bounded-response'
import { JsonArraySchema, JsonObjectSchema, NumericSchema, TextSchema, type JsonObject, type JsonValue } from '../domain/json-payload'

export interface RedditCredentials {
  clientId: string
  clientSecret: string
}

function record(value: JsonValue): JsonObject {
  return JsonObjectSchema.safeParse(value).data ?? {}
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
  if (!tokenResponse.ok) {
    await tokenResponse.body?.cancel()
    throw new Error(`Reddit OAuth returned ${tokenResponse.status}`)
  }
  const token = TextSchema.safeParse(record(await readBoundedJson(tokenResponse, 256_000, 'RedditOAuth')).access_token).data
  if (!token) throw new Error('Reddit OAuth returned no access token')

  const listingResponse = await fetcher('https://oauth.reddit.com/r/options+wallstreetbets+stocks/hot?limit=18&raw_json=1', {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'SpiceMustFlow/0.1 personal-options-research' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!listingResponse.ok) {
    await listingResponse.body?.cancel()
    throw new Error(`Reddit listing returned ${listingResponse.status}`)
  }
  const listing = record(await readBoundedJson(listingResponse, 2_000_000, 'RedditListing'))
  const children = JsonArraySchema.safeParse(record(listing.data).children).data
  if (!children) return []

  return children
    .map((child) => record(record(child).data))
    .flatMap((post) => {
      const title = TextSchema.safeParse(post.title).data
      const permalink = TextSchema.safeParse(post.permalink).data
      if (title === undefined || permalink === undefined) return []
      const url = redditUrl(permalink)
      return url ? [{ post, title, url }] : []
    })
    .sort((left, right) => Number(right.post.score ?? 0) - Number(left.post.score ?? 0))
    .slice(0, 6)
    .map(({ post, title, url }) => {
      const published = new Date((NumericSchema.safeParse(post.created_utc).data ?? Number.NaN) * 1_000)
      return {
        source: `Reddit · r/${TextSchema.safeParse(post.subreddit).data ?? 'markets'}`,
        title: title.slice(0, 240),
        url,
        publishedAt: Number.isNaN(published.valueOf()) ? undefined : published.toISOString(),
      }
    })
}
