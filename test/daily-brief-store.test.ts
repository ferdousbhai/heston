import { describe, expect, it } from 'vitest'

import { publishDailyBrief, readDailyBriefBefore, readLatestDailyBrief } from '../src/server/daily-brief-store'
import { dailyBriefFixture } from './fixtures/market'
import { migrationStore } from './sqlite-d1'

const { id: _id, publishedAt: _publishedAt, ...submission } = dailyBriefFixture

describe('daily brief store', () => {
  it('publishes a submission with its own id and instant, and replaces the same market date', async () => {
    const store = await migrationStore()
    const first = await publishDailyBrief(store.database, submission, new Date('2026-08-13T13:35:00.000Z'))
    expect(first.id).toBe('brief-2026-08-13')
    expect(first.publishedAt).toBe('2026-08-13T13:35:00.000Z')

    const second = await publishDailyBrief(store.database, { ...submission, recommendations: [] }, new Date('2026-08-13T14:00:00.000Z'))
    expect(second.id).toBe(first.id)
    await expect(readLatestDailyBrief(store.database)).resolves.toEqual(second)
    expect(store.sqlite.prepare('SELECT COUNT(*) AS n FROM daily_briefs').get()).toEqual({ n: 1 })
    store.close()
  })

  it('refuses a submission outside the contract before anything is written', async () => {
    const store = await migrationStore()
    await expect(publishDailyBrief(store.database, { ...submission, model: '' })).rejects.toThrow()
    // A caller's claim is not the contract: an id smuggled in with the submission is refused.
    // SAFETY: the widened value is exactly what this case exists to reject.
    await expect(publishDailyBrief(store.database, { ...submission, id: 'brief-2026-08-13' } as never)).rejects.toThrow()
    await expect(readLatestDailyBrief(store.database)).resolves.toBeUndefined()
    store.close()
  })

  it('walks the archive one issue at a time', async () => {
    const store = await migrationStore()
    await publishDailyBrief(store.database, { ...submission, marketDate: '2026-08-12' }, new Date('2026-08-12T13:35:00.000Z'))
    const latest = await publishDailyBrief(store.database, submission, new Date('2026-08-13T13:35:00.000Z'))
    const previous = await readDailyBriefBefore(store.database, latest.publishedAt)
    expect(previous?.id).toBe('brief-2026-08-12')
    await expect(readDailyBriefBefore(store.database, previous!.publishedAt)).resolves.toBeUndefined()
    store.close()
  })

  it('fails visibly on a stored row that no longer fits the contract', async () => {
    const store = await migrationStore()
    store.sqlite.prepare(
      'INSERT INTO daily_briefs (id, market_date, published_at, payload_json) VALUES (?, ?, ?, ?)',
    ).run('brief-2026-08-13', '2026-08-13', '2026-08-13T13:35:00.000Z', JSON.stringify({ id: 'brief-2026-08-13', ideas: [] }))
    await expect(readLatestDailyBrief(store.database)).rejects.toThrow()
    store.close()
  })
})
