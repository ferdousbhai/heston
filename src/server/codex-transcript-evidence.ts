import { z } from 'zod'

const SOCIAL_DOMAINS = ['reddit.com', 'redd.it', 'x.com', 'twitter.com', 't.co'] as const

function isSocialHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  return SOCIAL_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

const OpenPageEventSchema = z.object({
  item: z.object({
    action: z.object({
      type: z.literal('open_page'),
      url: z.string(),
    }),
    type: z.literal('web_search'),
  }),
  type: z.literal('item.completed'),
})

export function canonicalCodexSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || isSocialHost(url.hostname)) {
      return undefined
    }
    // A terminal DNS root dot is semantically equivalent but must not create a
    // second evidence identity or bypass exact hostname policy.
    url.hostname = url.hostname.replace(/\.$/, '')
    url.hash = ''
    return url.toString()
  } catch {
    return undefined
  }
}

/**
 * Derive evidence at the apply boundary from raw Codex JSONL. URL-shaped search
 * queries, find-in-page actions, and legacy/ambiguous `other` actions are not
 * proof that the cited page was opened.
 */
export function openedPageUrlsFromCodexTranscripts(transcripts: readonly string[]): Set<string> {
  const opened = new Set<string>()
  for (const transcript of transcripts) {
    for (const line of transcript.split('\n')) {
      if (!line) continue
      let event: unknown
      try {
        event = JSON.parse(line)
      } catch {
        throw new Error('CatalystBootstrap:invalid-codex-transcript')
      }
      const parsed = OpenPageEventSchema.safeParse(event)
      if (!parsed.success) continue
      const url = canonicalCodexSourceUrl(parsed.data.item.action.url)
      if (url) opened.add(url)
    }
  }
  return opened
}
