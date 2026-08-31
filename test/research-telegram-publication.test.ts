import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ResearchBriefSchema, type ResearchBrief } from '../src/domain/market'
import {
  publishResearchBriefToTelegram,
  researchBriefTelegramMessages,
} from '../src/server/research-telegram-publication'
import { upsertResearchBrief } from '../src/server/research-brief-store'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const BOT_TOKEN = '123456:telegram_test_token'
const CHAT_ID = '-1001234567890'

function researchBrief(): ResearchBrief {
  return ResearchBriefSchema.parse({
    id: 'brief-2026-08-31',
    ideas: [{
      description: 'A signed agreement improves demand visibility while volatility remains usable.',
      direction: 'bullish',
      headline: 'Supply agreement improves visibility',
      play: 'NVDA 225c 10/16',
      risk: 'Delivery timing slips or volume fails to convert to revenue.',
      sources: [{
        label: 'NVIDIA supply agreement',
        url: 'https://example.com/nvidia-agreement',
      }],
      symbol: 'NVDA',
    }],
    publishedAt: '2026-08-31T13:30:00.000Z',
    readingList: [],
    regime: 'Selective',
    regimeDetail: 'Prefer company-specific catalysts with usable volatility.',
    sources: [{
      label: 'NVIDIA supply agreement',
      url: 'https://example.com/nvidia-agreement',
    }],
    summary: 'One falsifiable company-specific setup stands out.',
    title: 'Selective convexity',
  })
}

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => {
  vi.restoreAllMocks()
  store.close()
})

describe('research brief Telegram publication', () => {
  it('renders one compact, sourced message per ranked idea', () => {
    expect(researchBriefTelegramMessages(researchBrief())).toEqual([
      `NVDA · Bullish

Supply agreement improves visibility

A signed agreement improves demand visibility while volatility remains usable.

Potential play: NVDA 225c 10/16

Risk: Delivery timing slips or volume fails to convert to revenue.

Sources:
https://example.com/nvidia-agreement

Not financial advice.`,
    ])
    expect(researchBriefTelegramMessages({ ...researchBrief(), ideas: [] })).toEqual([])
  })

  it('does not require a destination for a brief with no ideas', async () => {
    await expect(publishResearchBriefToTelegram({}, { ...researchBrief(), ideas: [] }))
      .resolves.toBe(0)
  })

  it('fails before reserving when a message exceeds Telegram limits or lacks evidence', async () => {
    const tooLong = {
      ...researchBrief(),
      ideas: [{ ...researchBrief().ideas[0]!, description: 'x'.repeat(4_096) }],
    }
    expect(() => researchBriefTelegramMessages(tooLong))
      .toThrow('TelegramPublicationMessageTooLong:0')
    expect(() => researchBriefTelegramMessages({
      ...researchBrief(),
      ideas: [{ ...researchBrief().ideas[0]!, sources: [] }],
    })).toThrow('TelegramPublicationSourcesMissing:0')
  })

  it('sends a persisted brief once and replays from its delivered receipt', async () => {
    const brief = researchBrief()
    await upsertResearchBrief(store.database, brief)
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      ok: true,
      result: { message_id: 321 },
    }))
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const env = {
      DB: store.database,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_LONG_VOL_CHAT_ID: CHAT_ID,
    }

    await expect(publishResearchBriefToTelegram(env, brief, { fetcher })).resolves.toBe(1)
    await expect(publishResearchBriefToTelegram(env, brief, { fetcher })).resolves.toBe(1)

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`)
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: CHAT_ID,
      link_preview_options: { is_disabled: true },
      text: researchBriefTelegramMessages(brief)[0],
    })
    expect(store.sqlite.prepare(
      `SELECT status, telegram_message_id, error_code
       FROM research_brief_telegram_publications`,
    ).get()).toEqual({ error_code: null, status: 'delivered', telegram_message_id: 321 })
  })

  it('never repeats a send whose network outcome is ambiguous', async () => {
    const brief = researchBrief()
    await upsertResearchBrief(store.database, brief)
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error(`connection closed after ${BOT_TOKEN}`)
    })
    const env = {
      DB: store.database,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_LONG_VOL_CHAT_ID: CHAT_ID,
    }

    await expect(publishResearchBriefToTelegram(env, brief, { fetcher }))
      .rejects.toThrow('TelegramRequestAmbiguous')
    await expect(publishResearchBriefToTelegram(env, brief, { fetcher }))
      .rejects.toThrow('TelegramPublicationAmbiguous:0')

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(store.sqlite.prepare(
      `SELECT status, error_code FROM research_brief_telegram_publications`,
    ).get()).toEqual({ error_code: 'TelegramRequestAmbiguous', status: 'ambiguous' })
  })

  it('records a definite Telegram rejection without exposing its response body', async () => {
    const brief = researchBrief()
    await upsertResearchBrief(store.database, brief)
    const fetcher = vi.fn<typeof fetch>(async () => new Response('provider details', { status: 403 }))
    const env = {
      DB: store.database,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_LONG_VOL_CHAT_ID: CHAT_ID,
    }

    await expect(publishResearchBriefToTelegram(env, brief, { fetcher }))
      .rejects.toThrow('TelegramHttpFailure:403')
    await expect(publishResearchBriefToTelegram(env, brief, { fetcher }))
      .rejects.toThrow('TelegramPublicationFailed:0')

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(store.sqlite.prepare(
      `SELECT status, error_code FROM research_brief_telegram_publications`,
    ).get()).toEqual({ error_code: 'TelegramHttpFailure:403', status: 'failed' })
  })

  it('does not reserve anything when required secrets are unavailable', async () => {
    const brief = researchBrief()
    await upsertResearchBrief(store.database, brief)

    await expect(publishResearchBriefToTelegram({ DB: store.database }, brief))
      .rejects.toThrow('SecretBindingMissing:TELEGRAM_BOT_TOKEN')
    expect(store.sqlite.prepare(
      'SELECT count(*) AS count FROM research_brief_telegram_publications',
    ).get()).toEqual({ count: 0 })
  })

  it('fails before reserving when the configured public destination is absent', async () => {
    const brief = researchBrief()
    await upsertResearchBrief(store.database, brief)

    await expect(publishResearchBriefToTelegram({
      DB: store.database,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    }, brief)).rejects.toThrow('TelegramChatIdMissing')
    expect(store.sqlite.prepare(
      'SELECT count(*) AS count FROM research_brief_telegram_publications',
    ).get()).toEqual({ count: 0 })
  })
})
