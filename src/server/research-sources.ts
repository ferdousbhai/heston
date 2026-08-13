import { type ResearchSourceItem } from './research-contracts'
import { collectRedditSources, type RedditCredentials } from './research-reddit'

export { type ResearchSourceItem } from './research-contracts'

interface FeedDefinition {
  name: string
  url: string
}

const OFFICIAL_FEEDS: FeedDefinition[] = [
  { name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml' },
  { name: 'SEC', url: 'https://www.sec.gov/news/pressreleases.rss' },
]

const MAX_FEED_BYTES = 750_000
const MAX_ITEMS_PER_FEED = 4

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function element(block: string, name: string): string | undefined {
  const value = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1]
  return value ? decodeXml(value) : undefined
}

function safeHttpsUrl(value: string | undefined, baseUrl: string): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value, baseUrl)
    return url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

/** Parse the small RSS/Atom subset used by the fixed official feeds. */
export function parseResearchFeed(xml: string, feed: FeedDefinition): ResearchSourceItem[] {
  const rssItems = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? []
  const atomItems = xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) ?? []

  return [...rssItems, ...atomItems].flatMap((block) => {
    const atomHref = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?\s*>/i)?.[1]
    const title = element(block, 'title')
    const url = safeHttpsUrl(element(block, 'link') ?? atomHref, feed.url)
    if (!title || !url) return []

    const published = element(block, 'pubDate') ?? element(block, 'published') ?? element(block, 'updated')
    const publishedDate = published ? new Date(published) : undefined
    return [{
      source: feed.name,
      title,
      url,
      publishedAt: publishedDate && !Number.isNaN(publishedDate.valueOf()) ? publishedDate.toISOString() : undefined,
    }]
  }).slice(0, MAX_ITEMS_PER_FEED)
}

async function fetchFeed(feed: FeedDefinition, fetcher: typeof fetch): Promise<ResearchSourceItem[]> {
  const response = await fetcher(feed.url, {
    headers: { Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml' },
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) throw new Error(`${feed.name} feed returned ${response.status}`)
  const body = await response.text()
  if (body.length > MAX_FEED_BYTES) throw new Error(`${feed.name} feed exceeded the size limit`)
  return parseResearchFeed(body, feed)
}

/** One unavailable publisher must not prevent the daily issue from being generated. */
export async function collectResearchSources(options: {
  fetcher?: typeof fetch
  reddit?: RedditCredentials
} = {}): Promise<ResearchSourceItem[]> {
  const fetcher = options.fetcher ?? fetch
  const collectors: Promise<ResearchSourceItem[]>[] = OFFICIAL_FEEDS.map((feed) => fetchFeed(feed, fetcher))
  if (options.reddit) collectors.push(collectRedditSources(options.reddit, fetcher))
  const results = await Promise.allSettled(collectors)
  return results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
}
