import { z } from 'zod'

import { CHANNEL_ARCHIVE_PAGE_SIZE, ChannelArchivePageSchema, type ChannelArchivePage } from '../domain/channel-post'

const StoredPostRowSchema = z.object({
  links_json: z.string(),
  post_id: z.number().int().positive(),
  posted_at: z.string(),
  text: z.string(),
})

/**
 * Newest first, paged by post id. One row past the page is read so the page can say whether
 * an older one exists without a second query.
 */
export async function readChannelArchivePage(db: D1Database, before?: number): Promise<ChannelArchivePage> {
  const statement = before === undefined
    ? db.prepare('SELECT post_id, posted_at, text, links_json FROM long_vol_channel_posts ORDER BY post_id DESC LIMIT ?').bind(CHANNEL_ARCHIVE_PAGE_SIZE + 1)
    : db.prepare('SELECT post_id, posted_at, text, links_json FROM long_vol_channel_posts WHERE post_id < ? ORDER BY post_id DESC LIMIT ?').bind(before, CHANNEL_ARCHIVE_PAGE_SIZE + 1)
  const { results } = await statement.all()
  const rows = z.array(StoredPostRowSchema).parse(results)
  const page = rows.slice(0, CHANNEL_ARCHIVE_PAGE_SIZE)
  const nextBefore = rows.length > CHANNEL_ARCHIVE_PAGE_SIZE ? page.at(-1)?.post_id : undefined
  return ChannelArchivePageSchema.parse({
    nextBefore,
    posts: page.map((row) => ({
      id: row.post_id,
      links: JSON.parse(row.links_json),
      postedAt: row.posted_at,
      text: row.text,
    })),
  })
}
