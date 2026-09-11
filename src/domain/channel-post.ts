import { z } from 'zod'

/**
 * A post from the retired Long Vol channel, as the site keeps it: text and links only. The
 * channel's own markup never reaches a reader's page; links are rendered from this list, and
 * only over HTTPS.
 */
export const ChannelPostSchema = z.strictObject({
  id: z.number().int().positive(),
  links: z.array(z.url({ error: 'Use an HTTPS link', protocol: /^https$/ })),
  postedAt: z.string().datetime({ offset: true }),
  text: z.string().min(1),
})

export type ChannelPost = z.infer<typeof ChannelPostSchema>

/**
 * One tap on "older" reveals this many posts. The archive is finite and read once per reader,
 * so the page is sized for a phone screen of short posts rather than for transfer cost.
 */
export const CHANNEL_ARCHIVE_PAGE_SIZE = 20

export const ChannelArchivePageSchema = z.strictObject({
  // The id to pass back as `before` for the next page; absent when this page is the last.
  nextBefore: z.number().int().positive().optional(),
  posts: z.array(ChannelPostSchema).max(CHANNEL_ARCHIVE_PAGE_SIZE),
})

export type ChannelArchivePage = z.infer<typeof ChannelArchivePageSchema>
