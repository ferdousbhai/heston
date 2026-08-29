import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { readLatestResearchBrief, upsertResearchBrief } from '../src/server/research-brief-store'
import { unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const brief = {
  id: 'daily-2026-08-28',
  ideas: [],
  publishedAt: '2026-08-28T13:30:00.000Z',
  readingList: [],
  regime: 'Cautious',
  regimeDetail: 'Wait for confirmation.',
  sources: [],
  summary: 'Liquidity is thin.',
  title: 'Wait for the pitch',
}

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => store.close())

describe('research brief store', () => {
  it('returns absence and upserts a strictly valid latest brief', async () => {
    await expect(readLatestResearchBrief(store.database)).resolves.toBeUndefined()

    await upsertResearchBrief(store.database, brief)
    await upsertResearchBrief(store.database, { ...brief, summary: 'Conditions improved.' })

    await expect(readLatestResearchBrief(store.database)).resolves.toMatchObject({
      id: brief.id,
      summary: 'Conditions improved.',
    })
    expect(store.sqlite.prepare('SELECT count(*) AS count FROM research_briefs').get()).toEqual({ count: 1 })
  })

  it('fails visibly for malformed persisted JSON and domain data', async () => {
    const invalidJsonDatabase: D1Database = {
      ...unsupportedDatabase(),
      prepare: () => ({ ...unsupportedStatement(), first: async () => ({ payload_json: '{' }) }),
    }
    await expect(readLatestResearchBrief(invalidJsonDatabase)).rejects.toThrow()

    store.sqlite.prepare(
      'INSERT INTO research_briefs (id, published_at, payload_json) VALUES (?, ?, ?)',
    ).run('broken', '2026-08-29T13:30:00.000Z', '{}')
    await expect(readLatestResearchBrief(store.database)).rejects.toThrow()
  })
})
