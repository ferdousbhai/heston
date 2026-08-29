import { readBoundedJson } from './bounded-response'
import { z } from 'zod'

import { type JsonValue } from '../domain/json-payload'

export interface RedditCredentials {
  clientId: string
  clientSecret: string
}

type RedditPost = {
  numComments: number
  publishedAt: string
  score: number
  selfText?: string
  title: string
  url: string
}

export type RedditDiscussion = {
  commentCount: number
  context: string
  publishedAt: string
  score: number
  source: typeof REDDIT_RESEARCH_SOURCE
  title: string
  url: string
}

const USER_AGENT = 'SpiceMustFlow/0.2 personal-options-research'
export const REDDIT_RESEARCH_SOURCE = 'Reddit · r/wallstreetbets'
const MAX_POSTS_REVIEWED = 20
const MAX_COMMENTS_PER_POST = 10
const MAX_POST_TEXT = 4_000
const MAX_COMMENT_TEXT = 1_600
const POST_FETCH_CONCURRENCY = 5

const RedditPostSchema = z.object({
  created_utc: z.number().finite().positive(),
  num_comments: z.number().int().nonnegative(),
  permalink: z.string().min(1),
  score: z.number().int(),
  selftext: z.string(),
  subreddit: z.string(),
  title: z.string().min(1),
}).passthrough()

const RedditListingSchema = z.object({
  data: z.object({
    children: z.array(z.object({ data: RedditPostSchema }).passthrough()),
  }).passthrough(),
}).passthrough()

const RedditCommentSchema = z.object({
  author: z.string(),
  body: z.string(),
  score: z.number().int(),
  stickied: z.boolean(),
}).passthrough()

const RedditCommentListingSchema = z.object({
  data: z.object({
    children: z.array(z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('t1'), data: RedditCommentSchema }).passthrough(),
      z.object({ kind: z.literal('more'), data: z.object({}).passthrough() }).passthrough(),
    ])),
  }).passthrough(),
}).passthrough()

const RedditOAuthSchema = z.object({ access_token: z.string().min(1) }).passthrough()

function redditUrl(value: string): string | undefined {
  try {
    const url = new URL(value, 'https://www.reddit.com')
    return url.protocol === 'https:' && url.hostname === 'www.reddit.com' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function compactText(value: string | undefined, maxLength: number): string | undefined {
  const compact = value?.replace(/\s+/g, ' ').trim()
  if (!compact || compact === '[deleted]' || compact === '[removed]') return undefined
  return compact.slice(0, maxLength)
}

function commentBodies(payload: JsonValue): string[] {
  const listings = z.array(z.unknown()).min(2).parse(payload)
  const children = RedditCommentListingSchema.parse(listings[1]).data.children
  const comments = children
    .flatMap((child) => child.kind === 't1' ? [child.data] : [])
  if (comments.length > MAX_COMMENTS_PER_POST) throw new Error('Reddit returned too many comments')
  return comments
    .filter((comment) => !comment.stickied && comment.author !== 'AutoModerator')
    .map((comment) => compactText(comment.body, MAX_COMMENT_TEXT))
    .filter((comment): comment is string => Boolean(comment))
}

async function topComments(postUrl: string, token: string, fetcher: typeof fetch): Promise<string[]> {
  const path = new URL(postUrl).pathname.replace(/\/$/, '')
  const response = await fetcher(`https://oauth.reddit.com${path}.json?sort=top&limit=${MAX_COMMENTS_PER_POST}&depth=1&raw_json=1`, {
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
  let children: z.infer<typeof RedditListingSchema>['data']['children']
  try {
    children = RedditListingSchema.parse(payload).data.children
  } catch (cause) {
    throw new Error('Reddit listing returned an invalid response', { cause })
  }
  return children
    .map(({ data: post }) => {
      if (post.subreddit.toLowerCase() !== 'wallstreetbets') {
        throw new Error('Reddit listing returned a cross-subreddit post')
      }
      const url = redditUrl(post.permalink)
      if (!url) throw new Error('Reddit listing returned an invalid permalink')
      const published = new Date(post.created_utc * 1_000)
      if (Number.isNaN(published.valueOf())) throw new Error('Reddit listing returned an invalid timestamp')
      return {
        numComments: post.num_comments,
        publishedAt: published.toISOString(),
        score: post.score,
        selfText: compactText(post.selftext, MAX_POST_TEXT),
        title: post.title.replace(/\s+/g, ' ').trim().slice(0, 240),
        url,
      }
    })
}

async function enrichPost(
  post: RedditPost,
  token: string,
  fetcher: typeof fetch,
): Promise<RedditDiscussion> {
  const comments = await topComments(post.url, token, fetcher)
  const evidence = [
    post.selfText ? `Post: ${post.selfText}` : undefined,
    comments.length ? `Top comments: ${comments.map((comment) => `• ${comment}`).join(' ')}` : undefined,
  ].filter((item): item is string => Boolean(item))
  return {
    commentCount: post.numComments,
    context: evidence.join('\n'),
    publishedAt: post.publishedAt,
    score: post.score,
    source: REDDIT_RESEARCH_SOURCE,
    title: post.title,
    url: post.url,
  }
}

export async function collectRedditSources(
  credentials: RedditCredentials,
  fetcher: typeof fetch = fetch,
): Promise<RedditDiscussion[]> {
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
  const token = RedditOAuthSchema.parse(
    await readBoundedJson(tokenResponse, 256_000, 'RedditOAuth'),
  ).access_token

  const listingResponse = await fetcher(`https://oauth.reddit.com/r/wallstreetbets/hot?limit=${MAX_POSTS_REVIEWED}&raw_json=1`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(8_000),
  })
  if (!listingResponse.ok) {
    await listingResponse.body?.cancel()
    throw new Error(`Reddit listing returned ${listingResponse.status}`)
  }
  const posts = listingPosts(await readBoundedJson(listingResponse, 2_000_000, 'RedditListing'))
  if (posts.length > MAX_POSTS_REVIEWED) throw new Error('Reddit listing exceeded the requested post limit')
  const discussions: RedditDiscussion[] = []
  for (let index = 0; index < posts.length; index += POST_FETCH_CONCURRENCY) {
    discussions.push(...await Promise.all(
      posts.slice(index, index + POST_FETCH_CONCURRENCY).map((post) => enrichPost(post, token, fetcher)),
    ))
  }
  return discussions
}
