import { type ResearchSourceItem } from './research-contracts'
import { readBoundedJson } from './bounded-response'
import { JsonArraySchema, jsonNumber, jsonObjectOrEmpty, jsonText, type JsonValue } from '../domain/json-payload'

export interface RedditCredentials {
  clientId: string
  clientSecret: string
}

type RedditPost = {
  numComments: number
  outboundUrl?: string
  publishedAt?: string
  score: number
  selfText?: string
  title: string
  url: string
}

const USER_AGENT = 'SpiceMustFlow/0.2 personal-options-research'
export const REDDIT_RESEARCH_SOURCE = 'Reddit · r/wallstreetbets'
const MAX_POSTS_REVIEWED = 6
const MAX_COMMENTS_PER_POST = 4
const MAX_POST_TEXT = 4_000
const MAX_COMMENT_TEXT = 1_600
const MAX_LINK_BYTES = 180_000
const MAX_LINK_TEXT = 4_000

function redditUrl(value: string): string | undefined {
  try {
    const url = new URL(value, 'https://www.reddit.com')
    return url.protocol === 'https:' && url.hostname === 'www.reddit.com' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function outboundUrl(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/\.$/, '')
    const isIpLiteral = host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host) || /^\d+$/.test(host)
    const isLocal = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')
      || host.endsWith('.internal')
    const isReddit = host === 'reddit.com' || host.endsWith('.reddit.com') || host === 'redd.it'
      || host.endsWith('.redd.it')
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || isIpLiteral || isLocal || isReddit) return undefined
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

function compactText(value: string | undefined, maxLength: number): string | undefined {
  const compact = value?.replace(/\s+/g, ' ').trim()
  if (!compact || compact === '[deleted]' || compact === '[removed]') return undefined
  return compact.slice(0, maxLength)
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

function readableHtml(value: string): string | undefined {
  return compactText(decodeHtml(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')), MAX_LINK_TEXT)
}

/** Read only the prefix useful to the editor, then cancel the remaining body. */
async function readTextPrefix(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = maxBytes - total
      const chunk = value.byteLength <= remaining ? value : value.slice(0, remaining)
      chunks.push(chunk)
      total += chunk.byteLength
      if (value.byteLength > remaining) {
        await reader.cancel()
        break
      }
    }
    if (total === maxBytes) await reader.cancel()
  } finally {
    reader.releaseLock()
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

async function linkedPage(
  url: string | undefined,
  fetcher: typeof fetch,
): Promise<{ excerpt: string; label: string; url: string } | undefined> {
  if (!url) return undefined
  const response = await fetcher(url, {
    headers: { Accept: 'text/html, text/plain;q=0.9', 'User-Agent': USER_AGENT },
    redirect: 'manual',
    signal: AbortSignal.timeout(8_000),
  })
  const finalUrl = outboundUrl(response.url || url)
  const contentType = response.headers.get('Content-Type')?.toLowerCase() ?? ''
  if (!response.ok || !finalUrl || (!contentType.includes('text/html') && !contentType.includes('text/plain'))) {
    await response.body?.cancel()
    return undefined
  }
  const raw = await readTextPrefix(response, MAX_LINK_BYTES)
  const excerpt = contentType.includes('text/html') ? readableHtml(raw) : compactText(raw, MAX_LINK_TEXT)
  if (!excerpt) return undefined
  return { excerpt, label: new URL(finalUrl).hostname.replace(/^www\./, ''), url: finalUrl }
}

function commentBodies(payload: JsonValue): string[] {
  const listings = JsonArraySchema.safeParse(payload).data
  const commentListing = jsonObjectOrEmpty(listings?.[1])
  const children = JsonArraySchema.safeParse(jsonObjectOrEmpty(commentListing.data).children).data ?? []
  return children
    .map((child) => jsonObjectOrEmpty(jsonObjectOrEmpty(child).data))
    .filter((comment) => comment.stickied !== true && jsonText(comment.author) !== 'AutoModerator')
    .map((comment) => ({ body: compactText(jsonText(comment.body), MAX_COMMENT_TEXT), score: jsonNumber(comment.score) ?? 0 }))
    .filter((comment): comment is { body: string; score: number } => Boolean(comment.body))
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_COMMENTS_PER_POST)
    .map((comment) => comment.body)
}

async function topComments(postUrl: string, token: string, fetcher: typeof fetch): Promise<string[]> {
  const path = new URL(postUrl).pathname.replace(/\/$/, '')
  const response = await fetcher(`https://oauth.reddit.com${path}.json?sort=top&limit=12&depth=1&raw_json=1`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Reddit comments returned ${response.status}`)
  }
  return commentBodies(await readBoundedJson(response, 2_000_000, 'RedditComments'))
}

function listingPosts(payload: JsonValue): RedditPost[] {
  const listing = jsonObjectOrEmpty(payload)
  const childrenResult = JsonArraySchema.safeParse(jsonObjectOrEmpty(listing.data).children)
  // Reddit is a required daily input. A valid empty listing is allowed, but a provider
  // shape change must fail the job instead of masquerading as successful zero evidence.
  if (!childrenResult.success) throw new Error('Reddit listing returned an invalid response')
  const children = childrenResult.data
  return children
    .map((child) => jsonObjectOrEmpty(jsonObjectOrEmpty(child).data))
    .flatMap((post) => {
      const title = compactText(jsonText(post.title), 240)
      const permalink = jsonText(post.permalink)
      if (!title || !permalink || post.stickied === true || jsonText(post.subreddit)?.toLowerCase() !== 'wallstreetbets') return []
      const url = redditUrl(permalink)
      if (!url) return []
      const published = new Date((jsonNumber(post.created_utc) ?? Number.NaN) * 1_000)
      const linked = post.is_self === true
        ? undefined
        : outboundUrl(jsonText(post.url_overridden_by_dest) ?? jsonText(post.url))
      return [{
        numComments: jsonNumber(post.num_comments) ?? 0,
        outboundUrl: linked,
        publishedAt: Number.isNaN(published.valueOf()) ? undefined : published.toISOString(),
        score: jsonNumber(post.score) ?? 0,
        selfText: compactText(jsonText(post.selftext), MAX_POST_TEXT),
        title,
        url,
      }]
    })
    .sort((left, right) => (right.score + right.numComments * 3) - (left.score + left.numComments * 3))
    .slice(0, MAX_POSTS_REVIEWED)
}

async function enrichPost(
  post: RedditPost,
  token: string,
  fetcher: typeof fetch,
): Promise<ResearchSourceItem> {
  const [commentsResult, linkResult] = await Promise.allSettled([
    topComments(post.url, token, fetcher),
    linkedPage(post.outboundUrl, fetcher),
  ])
  const comments = commentsResult.status === 'fulfilled' ? commentsResult.value : []
  const link = linkResult.status === 'fulfilled' ? linkResult.value : undefined
  const evidence = [
    post.selfText ? `Post: ${post.selfText}` : undefined,
    comments.length ? `Top comments: ${comments.map((comment) => `• ${comment}`).join(' ')}` : undefined,
    link ? `Linked page (${link.label}): ${link.excerpt}` : undefined,
  ].filter((item): item is string => Boolean(item))
  return {
    context: evidence.join('\n'),
    outbound: link ? { label: link.label, url: link.url } : undefined,
    publishedAt: post.publishedAt,
    source: REDDIT_RESEARCH_SOURCE,
    title: post.title,
    url: post.url,
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
      'User-Agent': USER_AGENT,
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(8_000),
  })
  if (!tokenResponse.ok) {
    await tokenResponse.body?.cancel()
    throw new Error(`Reddit OAuth returned ${tokenResponse.status}`)
  }
  const token = jsonText(jsonObjectOrEmpty(await readBoundedJson(tokenResponse, 256_000, 'RedditOAuth')).access_token)
  if (!token) throw new Error('Reddit OAuth returned no access token')

  const listingResponse = await fetcher('https://oauth.reddit.com/r/wallstreetbets/top?t=day&limit=25&raw_json=1', {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(8_000),
  })
  if (!listingResponse.ok) {
    await listingResponse.body?.cancel()
    throw new Error(`Reddit listing returned ${listingResponse.status}`)
  }
  const posts = listingPosts(await readBoundedJson(listingResponse, 2_000_000, 'RedditListing'))
  return Promise.all(posts.map((post) => enrichPost(post, token, fetcher)))
}
