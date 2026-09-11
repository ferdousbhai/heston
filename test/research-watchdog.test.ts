import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { watchDailyBrief } from '../src/server/research-watchdog'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { migrationStore } from './sqlite-d1'

const NOW = new Date('2026-09-02T15:30:00.000Z')

const broker = stubBroker()

beforeEach(() => {
  broker.tastyRequest.mockReset()
  setBrokerApi(broker)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  resetBrokerApi()
  vi.restoreAllMocks()
})

describe('the daily-brief watchdog', () => {
  it('stays quiet when today already published', async () => {
    const store = await migrationStore()
    try {
      store.sqlite.prepare('INSERT INTO daily_recommendations (id, published_at, payload_json) VALUES (?, ?, ?)')
        .run('recommendations-2026-09-02', NOW.toISOString(), '{}')
      await expect(watchDailyBrief({ DB: store.database }, NOW)).resolves.toBe('published')
      expect(broker.tastyRequest).not.toHaveBeenCalled()
    } finally {
      store.sqlite.close()
    }
  })

  it('owes no brief on a market holiday', async () => {
    const store = await migrationStore()
    try {
      broker.tastyRequest.mockResolvedValueOnce({ data: { state: 'Closed' } })
      await expect(watchDailyBrief({ DB: store.database }, NOW)).resolves.toBe('market-closed')
    } finally {
      store.sqlite.close()
    }
  })

  it('records a missing brief in the logs and sends nothing anywhere', async () => {
    const store = await migrationStore()
    const fetcher = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetcher)
    try {
      broker.tastyRequest.mockResolvedValueOnce({ data: { state: 'Open' } })
      await expect(watchDailyBrief({ DB: store.database }, NOW)).resolves.toBe('missing')
      // The record is the log line. The runner's own local log carries the reason; this is the
      // second opinion for the case that log cannot cover, because a machine that never woke
      // writes nothing. A watchdog with a push channel would also turn an internal failure into
      // a publication if it ever reached for the wrong chat id, so it has none.
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('DailyBriefMissing'))
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      store.sqlite.close()
    }
  })
})
