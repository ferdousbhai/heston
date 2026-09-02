import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { watchDailyBrief } from '../src/server/research-watchdog'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { migrationStore } from './sqlite-d1'

const NOW = new Date('2026-09-02T15:30:00.000Z')
const OWNER_CHAT: SecretsStoreSecret = { get: async () => '123456789' }

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

  it('alerts the owner chat, never the public channel, when the brief is missing', async () => {
    const store = await migrationStore()
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, result: { message_id: 7 } }))
    try {
      broker.tastyRequest.mockResolvedValueOnce({ data: { state: 'Open' } })
      await expect(watchDailyBrief({
        DB: store.database,
        TELEGRAM_BOT_TOKEN: '123456:telegram_test_token',
        TELEGRAM_LONG_VOL_CHAT_ID: '-1009999999999',
        TELEGRAM_OWNER_CHAT_ID: OWNER_CHAT,
      }, NOW, fetcher)).resolves.toBe('alerted')
      const [, init] = fetcher.mock.calls[0]!
      expect(String(init?.body)).toContain('"chat_id":"123456789"')
      expect(String(init?.body)).not.toContain('-1009999999999')
    } finally {
      store.sqlite.close()
    }
  })

  it('still fails loudly in logs when no owner chat is configured', async () => {
    const store = await migrationStore()
    try {
      broker.tastyRequest.mockResolvedValueOnce({ data: { state: 'Open' } })
      await expect(watchDailyBrief({ DB: store.database }, NOW)).resolves.toBe('unalertable')
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('DailyBriefMissing'))
    } finally {
      store.sqlite.close()
    }
  })
})
