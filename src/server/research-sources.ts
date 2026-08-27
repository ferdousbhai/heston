import { type ResearchSourceItem } from './research-contracts'
import { collectRedditSources as collectRedditEvidence } from './research-reddit'
import { collectTickerResearchSources as collectTickerEvidence } from './research-ticker-sources'
import { readBoundedText } from './bounded-response'

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
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`${feed.name} feed returned ${response.status}`)
  }
  const body = await readBoundedText(response, MAX_FEED_BYTES, `${feed.name}Feed`)
  return parseResearchFeed(body, feed)
}

/** One unavailable official publisher must not hide successful official evidence. */
export async function collectOfficialSources(fetcher: typeof fetch = fetch): Promise<ResearchSourceItem[]> {
  const results = await Promise.allSettled(OFFICIAL_FEEDS.map((feed) => fetchFeed(feed, fetcher)))
  return results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
}

/**
 * The headline collection the daily brief depends on. Production goes through
 * `researchSources()` so a test can install a stand-in with `setResearchSources`
 * instead of replacing this module.
 */
function createResearchSources() {
  return {
    collectOfficialSources,
    collectRedditSources: collectRedditEvidence,
    collectTickerSources: (symbols: readonly string[], now?: Date) => collectTickerEvidence(symbols, undefined, now),
  }
}

export type ResearchSources = ReturnType<typeof createResearchSources>

let installedResearchSources: ResearchSources = createResearchSources()

/** The headline collection currently in force. */
export function researchSources(): ResearchSources {
  return installedResearchSources
}

/** Install a stand-in collector for a test; pair every call with `resetResearchSources()`. */
export function setResearchSources(next: ResearchSources): void {
  installedResearchSources = next
}

/** Restore the live headline collection. */
export function resetResearchSources(): void {
  installedResearchSources = createResearchSources()
}
