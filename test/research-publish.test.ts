import { describe, expect, it, vi } from 'vitest'

import { publishSubmittedDailyRecommendations } from '../src/server/research-publish'
import { type DailyRecommendationsSubmission } from '../src/server/research-submission'
import { markdownBrowser } from './fake-browser'
import { migrationStore } from './sqlite-d1'

const NOW = new Date('2026-09-02T13:45:00.000Z')
const EVIDENCE_URL = 'https://www.reuters.com/technology/nvidia-supply'
const PAGE_MARKDOWN = '# NVIDIA\n\nThe company **signed a multi-year supply agreement** this week, with an investor day set for September 15, 2026.'
const BOT_TOKEN = '123456:telegram_test_token'
const CHAT_ID = '-1001234567890'

function submission(): DailyRecommendationsSubmission {
  return {
    catalysts: [{
      date: '2026-09-15',
      description: null,
      kind: 'investor-event',
      sourceIndex: 0,
      symbol: 'NVDA',
      timing: 'unknown',
      title: 'NVIDIA investor day',
    }],
    links: [{
      description: 'Contains the signed agreement terms.',
      recommendationIndex: 0,
      sourceIndex: 0,
      title: 'NVIDIA supply agreement',
    }],
    recommendations: [{
      description: 'A signed agreement improves demand visibility while volatility remains usable.',
      direction: 'bullish',
      evidence: [{ quote: 'signed a multi-year supply agreement', sourceIndex: 0 }],
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
      sourceIndices: [0],
      symbol: 'NVDA',
    }],
    regime: 'Selective',
    regimeDetail: 'Prefer company-specific catalysts with usable volatility.',
    sources: [{
      context: 'The agreement improves near-term demand visibility.',
      sourceUrl: EVIDENCE_URL,
      title: 'NVIDIA supply agreement',
    }],
    summary: 'One falsifiable company-specific setup stands out.',
    title: 'Selective convexity',
  }
}

function telegramFetcher() {
  return vi.fn<typeof fetch>(async () => Response.json({ ok: true, result: { message_id: 321 } }))
}

describe('publishing a submission produced off this Worker', () => {
  it('re-reads the cited page, binds everything, persists, and posts to the channel', async () => {
    const store = await migrationStore()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const fetcher = telegramFetcher()
    try {
      const publication = await publishSubmittedDailyRecommendations({
        BROWSER: markdownBrowser(PAGE_MARKDOWN),
        DB: store.database,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_LONG_VOL_CHAT_ID: CHAT_ID,
      }, submission(), { fetcher, now: NOW })

      expect(publication).toMatchObject({
        catalystCount: 1,
        id: 'recommendations-2026-09-02',
        linkCount: 1,
        recommendationCount: 1,
        status: 'published',
        telegramMessageCount: 1,
      })
      expect(store.sqlite.prepare('SELECT id FROM daily_recommendations WHERE id = ?')
        .get('recommendations-2026-09-02')).toEqual({ id: 'recommendations-2026-09-02' })
      expect(store.sqlite.prepare('SELECT source_provider FROM catalysts WHERE symbol = ?')
        .get('NVDA')).toEqual({ source_provider: 'daily-research' })
    } finally {
      store.sqlite.close()
    }
  })

  it('rejects with exact reasons when the page the Worker reads does not contain the quote', async () => {
    const store = await migrationStore()
    const fetcher = telegramFetcher()
    try {
      const publication = await publishSubmittedDailyRecommendations({
        BROWSER: markdownBrowser('# NVIDIA\n\nAn unrelated page that never mentions the agreement.'),
        DB: store.database,
        TELEGRAM_BOT_TOKEN: BOT_TOKEN,
        TELEGRAM_LONG_VOL_CHAT_ID: CHAT_ID,
      }, submission(), { fetcher, now: NOW })

      expect(publication.status).toBe('rejected')
      if (publication.status !== 'rejected') throw new Error('expected rejection')
      expect(publication.rejected.join('; ')).toContain('NVDA')
      // A rejected submission publishes nothing anywhere: no row, no channel post.
      expect(store.sqlite.prepare('SELECT COUNT(*) AS rows FROM daily_recommendations').get())
        .toEqual({ rows: 0 })
      expect(fetcher).not.toHaveBeenCalled()
    } finally {
      store.sqlite.close()
    }
  })

  it('refuses an empty brief rather than publishing a day with nothing in it', async () => {
    const store = await migrationStore()
    try {
      const empty = { ...submission(), catalysts: [], links: [], recommendations: [] }
      const publication = await publishSubmittedDailyRecommendations({
        BROWSER: markdownBrowser(PAGE_MARKDOWN),
        DB: store.database,
      }, empty, { now: NOW })
      expect(publication).toEqual({
        rejected: ['no recommendations submitted; a day without a brief publishes nothing'],
        status: 'rejected',
      })
    } finally {
      store.sqlite.close()
    }
  })

  it('fails closed without the browser binding instead of trusting the submission', async () => {
    const store = await migrationStore()
    try {
      await expect(publishSubmittedDailyRecommendations({ DB: store.database }, submission(), { now: NOW }))
        .rejects.toThrow('DailyResearchPublish:page-reading-unavailable')
    } finally {
      store.sqlite.close()
    }
  })
})
