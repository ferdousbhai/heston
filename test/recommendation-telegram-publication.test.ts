import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DailyRecommendationsSchema, type DailyRecommendations } from '../src/domain/market'
import {
  publishDailyRecommendationsToTelegram,
  dailyRecommendationsTelegramMessages,
} from '../src/server/recommendation-telegram-publication'
import { upsertDailyRecommendations } from '../src/server/daily-recommendations-store'
import { TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS } from '../src/server/telegram'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const BOT_TOKEN = '123456:telegram_test_token'
const CHAT_ID = '-1001234567890'

function dailyRecommendationsFixture(): DailyRecommendations {
  return DailyRecommendationsSchema.parse({
    id: 'recommendations-2026-08-31',
    recommendations: [{
      description: 'A signed agreement improves demand visibility while volatility remains usable.',
      direction: 'bullish',
      headline: 'Supply agreement improves visibility',
      recommendedOrder: {
        kind: 'equity-option',
        legs: [{
          action: 'Buy to Open',
          contract: { expiry: '2026-10-16', optionType: 'C', strike: 225, underlying: 'NVDA' },
          instrumentType: 'Equity Option',
        }],
      },
      risk: 'Delivery timing slips or volume fails to convert to revenue.',
      sources: [{
        label: 'NVIDIA supply agreement',
        url: 'https://example.com/nvidia-agreement',
      }],
      symbol: 'NVDA',
    }],
    publishedAt: '2026-08-31T13:30:00.000Z',
    links: [{
      description: 'The agreement terms behind the setup.',
      previewImageUrl: 'https://example.com/nvidia-preview.jpg',
      title: 'NVIDIA supply agreement',
      url: 'https://example.com/nvidia-agreement',
    }],
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

describe('research dailyRecommendations Telegram publication', () => {
  it('renders one compact, sourced message per ranked recommendation', () => {
    expect(dailyRecommendationsTelegramMessages(dailyRecommendationsFixture())).toEqual([{
      html: `<img src="https://example.com/nvidia-preview.jpg"/>

<p>Supply agreement improves visibility — A signed agreement improves demand visibility while volatility remains usable.</p>

<p><b>Buy $NVDA $225 Call October 16, 2026</b></p>

<p>Risk: Delivery timing slips or volume fails to convert to revenue.</p>

<p><a href="https://example.com/nvidia-agreement">NVIDIA supply agreement</a> — The agreement terms behind the setup.</p>`,
    }])
    expect(dailyRecommendationsTelegramMessages({
      ...dailyRecommendationsFixture(),
      links: [],
      recommendations: [],
    })).toEqual([])
  })

  it('pairs each ranked recommendation with exactly one reader link', () => {
    const dailyRecommendations = dailyRecommendationsFixture()
    const secondSource = {
      label: 'AMD product launch',
      url: 'https://example.com/amd-launch',
    }
    const messages = dailyRecommendationsTelegramMessages({
      ...dailyRecommendations,
      links: [
        ...dailyRecommendations.links,
        {
          description: 'The launch details that make the timing testable.',
          title: 'AMD product launch',
          url: secondSource.url,
        },
      ],
      recommendations: [
        ...dailyRecommendations.recommendations,
        {
          description: 'A new product cycle has a measurable adoption window.',
          direction: 'bullish',
          headline: 'The launch clock is finally running',
          recommendedOrder: {
            kind: 'equity',
            legs: [{ action: 'Buy to Open', instrumentType: 'Equity', symbol: 'AMD' }],
          },
          risk: 'Early channel checks show demand missing expectations.',
          sources: [secondSource],
          symbol: 'AMD',
        },
      ],
    })

    expect(messages).toHaveLength(2)
    expect(messages[1]?.html).toContain('<p><b>Buy $AMD Stock</b></p>')
    for (const message of messages) {
      expect(message.html.match(/<a href=/g)).toHaveLength(1)
    }
  })

  it('renders each debit-spread leg in the reader position format', () => {
    const dailyRecommendations = dailyRecommendationsFixture()
    const recommendation = dailyRecommendations.recommendations[0]!
    const [message] = dailyRecommendationsTelegramMessages({
      ...dailyRecommendations,
      recommendations: [{
        ...recommendation,
        direction: 'bearish',
        recommendedOrder: {
          kind: 'equity-option-vertical',
          legs: [
            {
              action: 'Buy to Open',
              contract: { expiry: '2026-10-16', optionType: 'P', strike: 225, underlying: 'NVDA' },
              instrumentType: 'Equity Option',
            },
            {
              action: 'Sell to Open',
              contract: { expiry: '2026-10-16', optionType: 'P', strike: 200, underlying: 'NVDA' },
              instrumentType: 'Equity Option',
            },
          ],
        },
      }],
    })

    expect(message?.html).toContain(
      '<p><b>Buy $NVDA $225 Put October 16, 2026<br>Sell $NVDA $200 Put October 16, 2026</b></p>',
    )
  })

  it('escapes model copy and URLs before producing Rich HTML', () => {
    const dailyRecommendations = dailyRecommendationsFixture()
    const recommendation = dailyRecommendations.recommendations[0]!
    const link = dailyRecommendations.links[0]!
    const [message] = dailyRecommendationsTelegramMessages({
      ...dailyRecommendations,
      links: [{
        ...link,
        description: 'Terms <final> & signed.',
        previewImageUrl: 'https://example.com/preview.jpg?a=1&b=2',
        title: 'Agreement <full> & final',
        url: 'https://example.com/agreement?a=1&b=2',
      }],
      recommendations: [{
        ...recommendation,
        description: 'Demand <supply & signed.',
        headline: 'Visibility & leverage',
        risk: 'Execution > expectations & slips.',
      }],
    })

    expect(message?.html).toContain('Visibility &amp; leverage — Demand &lt;supply &amp; signed.')
    expect(message?.html).toContain('src="https://example.com/preview.jpg?a=1&amp;b=2"')
    expect(message?.html).toContain('href="https://example.com/agreement?a=1&amp;b=2"')
    expect(message?.html).toContain('Agreement &lt;full&gt; &amp; final')
    expect(message?.html).not.toContain('<supply')
  })

  it('does not require a destination for a dailyRecommendations with no recommendations', async () => {
    await expect(publishDailyRecommendationsToTelegram({}, {
      ...dailyRecommendationsFixture(),
      links: [],
      recommendations: [],
    }))
      .resolves.toBe(0)
  })

  it('fails before reserving when a message exceeds Telegram limits or lacks evidence', async () => {
    const tooLong = {
      ...dailyRecommendationsFixture(),
      recommendations: [{
        ...dailyRecommendationsFixture().recommendations[0]!,
        description: 'x'.repeat(TELEGRAM_RICH_MESSAGE_MAX_CHARACTERS),
      }],
    }
    expect(() => dailyRecommendationsTelegramMessages(tooLong))
      .toThrow('TelegramPublicationMessageTooLong:0')
    expect(() => dailyRecommendationsTelegramMessages({
      ...dailyRecommendationsFixture(),
      recommendations: [{ ...dailyRecommendationsFixture().recommendations[0]!, sources: [] }],
    })).toThrow('TelegramPublicationSourcesMissing:0')
    expect(() => dailyRecommendationsTelegramMessages({
      ...dailyRecommendationsFixture(),
      links: [],
    })).toThrow('TelegramPublicationLinkCountMismatch:1:0')
  })

  it('sends a persisted dailyRecommendations once and replays from its delivered receipt', async () => {
    const dailyRecommendations = dailyRecommendationsFixture()
    await upsertDailyRecommendations(store.database, dailyRecommendations)
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

    await expect(publishDailyRecommendationsToTelegram(env, dailyRecommendations, { fetcher })).resolves.toBe(1)
    await expect(publishDailyRecommendationsToTelegram(env, dailyRecommendations, { fetcher })).resolves.toBe(1)

    expect(fetcher).toHaveBeenCalledTimes(1)
    const [url, init] = fetcher.mock.calls[0]!
    expect(url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendRichMessage`)
    expect(JSON.parse(String(init?.body))).toEqual({
      chat_id: CHAT_ID,
      rich_message: {
        html: dailyRecommendationsTelegramMessages(dailyRecommendations)[0]?.html,
      },
    })
    expect(store.sqlite.prepare(
      `SELECT status, telegram_message_id, error_code
       FROM daily_recommendation_telegram_publications`,
    ).get()).toEqual({ error_code: null, status: 'delivered', telegram_message_id: 321 })
  })

  it('never repeats a send whose network outcome is ambiguous', async () => {
    const dailyRecommendations = dailyRecommendationsFixture()
    await upsertDailyRecommendations(store.database, dailyRecommendations)
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error(`connection closed after ${BOT_TOKEN}`)
    })
    const env = {
      DB: store.database,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_LONG_VOL_CHAT_ID: CHAT_ID,
    }

    await expect(publishDailyRecommendationsToTelegram(env, dailyRecommendations, { fetcher }))
      .rejects.toThrow('TelegramRequestAmbiguous')
    await expect(publishDailyRecommendationsToTelegram(env, dailyRecommendations, { fetcher }))
      .rejects.toThrow('TelegramPublicationAmbiguous:0')

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(store.sqlite.prepare(
      `SELECT status, error_code FROM daily_recommendation_telegram_publications`,
    ).get()).toEqual({ error_code: 'TelegramRequestAmbiguous', status: 'ambiguous' })
  })

  it('records a definite Telegram rejection without exposing its response body', async () => {
    const dailyRecommendations = dailyRecommendationsFixture()
    await upsertDailyRecommendations(store.database, dailyRecommendations)
    const fetcher = vi.fn<typeof fetch>(async () => new Response('provider details', { status: 403 }))
    const env = {
      DB: store.database,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_LONG_VOL_CHAT_ID: CHAT_ID,
    }

    await expect(publishDailyRecommendationsToTelegram(env, dailyRecommendations, { fetcher }))
      .rejects.toThrow('TelegramHttpFailure:403')
    await expect(publishDailyRecommendationsToTelegram(env, dailyRecommendations, { fetcher }))
      .rejects.toThrow('TelegramPublicationFailed:0')

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(store.sqlite.prepare(
      `SELECT status, error_code FROM daily_recommendation_telegram_publications`,
    ).get()).toEqual({ error_code: 'TelegramHttpFailure:403', status: 'failed' })
  })

  it('does not reserve anything when required secrets are unavailable', async () => {
    const dailyRecommendations = dailyRecommendationsFixture()
    await upsertDailyRecommendations(store.database, dailyRecommendations)

    await expect(publishDailyRecommendationsToTelegram({ DB: store.database }, dailyRecommendations))
      .rejects.toThrow('SecretBindingMissing:TELEGRAM_BOT_TOKEN')
    expect(store.sqlite.prepare(
      'SELECT count(*) AS count FROM daily_recommendation_telegram_publications',
    ).get()).toEqual({ count: 0 })
  })

  it('fails before reserving when the configured public destination is absent', async () => {
    const dailyRecommendations = dailyRecommendationsFixture()
    await upsertDailyRecommendations(store.database, dailyRecommendations)

    await expect(publishDailyRecommendationsToTelegram({
      DB: store.database,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    }, dailyRecommendations)).rejects.toThrow('TelegramChatIdMissing')
    expect(store.sqlite.prepare(
      'SELECT count(*) AS count FROM daily_recommendation_telegram_publications',
    ).get()).toEqual({ count: 0 })
  })
})
