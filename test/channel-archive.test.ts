import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CHANNEL_ARCHIVE_PAGE_SIZE } from '../src/domain/channel-post'
import { readChannelArchivePage } from '../src/server/channel-archive'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => store.close())

function insert(id: number, text: string, links: string[] = []): void {
  store.sqlite.prepare(
    'INSERT INTO long_vol_channel_posts (post_id, posted_at, text, links_json, imported_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, `2026-03-${String(1 + (id % 28)).padStart(2, '0')}T13:30:00.000Z`, text, JSON.stringify(links), '2026-09-11T10:00:00.000Z')
}

describe('the surviving channel archive', () => {
  it('pages newest first and says when an older page exists', async () => {
    for (let id = 1; id <= CHANNEL_ARCHIVE_PAGE_SIZE + 2; id += 1) insert(id, `post ${id}`, ['https://example.com/' + id])

    const first = await readChannelArchivePage(store.database)
    expect(first.posts).toHaveLength(CHANNEL_ARCHIVE_PAGE_SIZE)
    expect(first.posts[0]).toMatchObject({ id: CHANNEL_ARCHIVE_PAGE_SIZE + 2, links: [`https://example.com/${CHANNEL_ARCHIVE_PAGE_SIZE + 2}`] })
    expect(first.nextBefore).toBe(3)

    const second = await readChannelArchivePage(store.database, first.nextBefore)
    expect(second.posts.map((post) => post.id)).toEqual([2, 1])
    // The last page names no cursor, so a reader is told the archive ends rather than offered nothing.
    expect(second.nextBefore).toBeUndefined()
  })

  it('answers an empty store with an empty page', async () => {
    await expect(readChannelArchivePage(store.database)).resolves.toEqual({ posts: [] })
  })

  it('refuses a link that is not HTTPS at the read boundary', async () => {
    insert(7, 'a post', ['http://example.com/plain'])
    await expect(readChannelArchivePage(store.database)).rejects.toThrow()
  })
})
