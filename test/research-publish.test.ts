import { describe, expect, it, vi } from 'vitest'

import { z } from 'zod'

import { DailyRecommendationsSchema, type DailyRecommendations } from '../src/domain/market'
import { RESEARCH_REFRESH_INTERVAL_MS } from '../src/domain/research-refresh'
import { publishSubmittedDailyRecommendations } from '../src/server/research-publish'
import { type DailyRecommendationsSubmission } from '../src/server/research-submission'
import { markdownBrowser } from './fake-browser'
import { migrationStore, seedMember } from './sqlite-d1'

const NOW = new Date('2026-09-02T13:45:00.000Z')
const PUBLISHER = 'member-1'
const EVIDENCE_URL = 'https://www.reuters.com/technology/nvidia-supply'
const PAGE_MARKDOWN = '# NVIDIA\n\nThe company **signed a multi-year supply agreement** this week, with an investor day set for September 15, 2026.'

/** A store whose member row exists, because a publication records the account behind it. */
async function publishingStore() {
  const store = await migrationStore()
  seedMember(store, PUBLISHER)
  return store
}

/** The stored brief, parsed through the same contract the site reads it with. */
function storedBrief(store: Awaited<ReturnType<typeof migrationStore>>, id: string): DailyRecommendations {
  const row = z.object({ payload_json: z.string() })
    .parse(store.sqlite.prepare('SELECT payload_json FROM daily_recommendations WHERE id = ?').get(id))
  return DailyRecommendationsSchema.parse(JSON.parse(row.payload_json))
}

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
    model: 'claude-opus-5',
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

describe('publishing a submission produced off this Worker', () => {
  it('re-reads the cited page, binds everything, and persists', async () => {
    const store = await publishingStore()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      const publication = await publishSubmittedDailyRecommendations({
        BROWSER: markdownBrowser(PAGE_MARKDOWN),
        DB: store.database,
      }, submission(), { now: NOW, publishedByUserId: PUBLISHER })

      expect(publication).toEqual({
        catalystCount: 1,
        id: 'recommendations-2026-09-02',
        linkCount: 1,
        recommendationCount: 1,
        status: 'published',
      })
      // The model travels with the brief, as the agent reported it, so the site can say so.
      expect(storedBrief(store, 'recommendations-2026-09-02'))
        .toMatchObject({ model: 'claude-opus-5', publishedAt: NOW.toISOString() })
      expect(store.sqlite.prepare('SELECT source_provider FROM catalysts WHERE symbol = ?')
        .get('NVDA')).toEqual({ source_provider: 'daily-research' })
    } finally {
      store.sqlite.close()
    }
  })

  it('publishes the chosen byline and the quotes, and keeps the publisher private', async () => {
    const store = await publishingStore()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      await expect(publishSubmittedDailyRecommendations({
        BROWSER: markdownBrowser(PAGE_MARKDOWN),
        DB: store.database,
      }, { ...submission(), byline: 'volhound' }, { now: NOW, publishedByUserId: PUBLISHER }))
        .resolves.toMatchObject({ status: 'published' })

      const brief = storedBrief(store, 'recommendations-2026-09-02')
      // What a reader is shown is the handle the member chose, and nothing else about them.
      expect(brief.byline).toBe('volhound')
      expect(JSON.stringify(brief)).not.toContain(PUBLISHER)
      // The quote the binder matched travels with the recommendation, addressed by its page.
      expect(brief.recommendations[0]?.evidence)
        .toEqual([{ quote: 'signed a multi-year supply agreement', url: EVIDENCE_URL }])
      // The account behind the publication is recorded beside the row, never inside it.
      expect(store.sqlite.prepare(
        'SELECT published_by_user_id FROM daily_recommendations WHERE id = ?',
      ).get('recommendations-2026-09-02')).toEqual({ published_by_user_id: PUBLISHER })
    } finally {
      store.sqlite.close()
    }
  })

  it('publishes no byline when the member named none', async () => {
    const store = await publishingStore()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      await publishSubmittedDailyRecommendations({
        BROWSER: markdownBrowser(PAGE_MARKDOWN),
        DB: store.database,
      }, submission(), { now: NOW, publishedByUserId: PUBLISHER })
      expect(storedBrief(store, 'recommendations-2026-09-02').byline).toBeUndefined()
    } finally {
      store.sqlite.close()
    }
  })

  it('rejects with exact reasons when the page the Worker reads does not contain the quote', async () => {
    const store = await publishingStore()
    try {
      const publication = await publishSubmittedDailyRecommendations({
        BROWSER: markdownBrowser('# NVIDIA\n\nAn unrelated page that never mentions the agreement.'),
        DB: store.database,
      }, submission(), { now: NOW, publishedByUserId: PUBLISHER })

      expect(publication.status).toBe('rejected')
      if (publication.status !== 'rejected') throw new Error('expected rejection')
      expect(publication.rejected.join('; ')).toContain('NVDA')
      // A rejected submission publishes nothing: no row.
      expect(store.sqlite.prepare('SELECT COUNT(*) AS rows FROM daily_recommendations').get())
        .toEqual({ rows: 0 })
    } finally {
      store.sqlite.close()
    }
  })

  it('refuses an empty brief rather than publishing a day with nothing in it', async () => {
    const store = await publishingStore()
    try {
      const empty = { ...submission(), catalysts: [], links: [], recommendations: [] }
      const publication = await publishSubmittedDailyRecommendations({
        BROWSER: markdownBrowser(PAGE_MARKDOWN),
        DB: store.database,
      }, empty, { now: NOW, publishedByUserId: PUBLISHER })
      expect(publication).toEqual({
        rejected: ['no recommendations submitted; a day without a brief publishes nothing'],
        status: 'rejected',
      })
    } finally {
      store.sqlite.close()
    }
  })

  it('lets a brief stand for the refresh interval before another may replace it', async () => {
    const store = await publishingStore()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    try {
      const env = { BROWSER: markdownBrowser(PAGE_MARKDOWN), DB: store.database }
      await expect(publishSubmittedDailyRecommendations(env, submission(), { now: NOW, publishedByUserId: PUBLISHER }))
        .resolves.toMatchObject({ status: 'published' })

      // One millisecond short, with a page the Worker never has to read: the gate runs first,
      // so a run that cannot publish yet spends no browser budget finding that out.
      const tooSoon = new Date(NOW.getTime() + RESEARCH_REFRESH_INTERVAL_MS - 1)
      const refused = await publishSubmittedDailyRecommendations(
        { BROWSER: markdownBrowser('# Nothing here'), DB: store.database },
        submission(),
        { now: tooSoon, publishedByUserId: PUBLISHER },
      )
      expect(refused.status).toBe('rejected')
      if (refused.status !== 'rejected') throw new Error('expected rejection')
      expect(refused.rejected).toHaveLength(1)
      expect(refused.rejected[0]).toContain('refresh interval')
      expect(refused.rejected[0]).toContain(new Date(NOW.getTime() + RESEARCH_REFRESH_INTERVAL_MS).toISOString())

      const opens = new Date(NOW.getTime() + RESEARCH_REFRESH_INTERVAL_MS)
      await expect(publishSubmittedDailyRecommendations(env, { ...submission(), model: 'gpt-5.4' }, { now: opens, publishedByUserId: PUBLISHER }))
        .resolves.toMatchObject({ status: 'published' })
      expect(storedBrief(store, 'recommendations-2026-09-02'))
        .toMatchObject({ model: 'gpt-5.4', publishedAt: opens.toISOString() })
    } finally {
      store.sqlite.close()
    }
  })

  it('fails closed without the browser binding instead of trusting the submission', async () => {
    const store = await publishingStore()
    try {
      await expect(publishSubmittedDailyRecommendations({ DB: store.database }, submission(), { now: NOW, publishedByUserId: PUBLISHER }))
        .rejects.toThrow('DailyResearchPublish:page-reading-unavailable')
    } finally {
      store.sqlite.close()
    }
  })
})
