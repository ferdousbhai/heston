import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DailyRecommendationsSchema, type DailyRecommendations } from '../src/domain/market'
import { RESEARCH_REFRESH_INTERVAL_MS } from '../src/domain/research-refresh'
import {
  dailyRecommendationsUpsertStatement,
  readLatestDailyRecommendations,
} from '../src/server/daily-recommendations-store'
import {
  challengeRecommendation,
  createRecommendationChallengeTool,
} from '../src/server/recommendation-challenge'
import { markdownBrowser } from './fake-browser'
import { migrationStore, seedMember, type SqliteD1Store } from './sqlite-d1'

const NOW = new Date('2026-09-02T13:45:00.000Z')
const PUBLISHER = 'member-1'
const EVIDENCE_URL = 'https://www.reuters.com/technology/nvidia-supply'
const QUOTE = 'signed a multi-year supply agreement'
const PAGE_MARKDOWN = `# NVIDIA\n\nThe company **${QUOTE}** this week.`
const REWRITTEN_PAGE = '# NVIDIA\n\nThe article was rewritten and says nothing of the kind now.'
const QUOTED_EVIDENCE = [{ quote: QUOTE, url: EVIDENCE_URL }]

/** A page this Worker can no longer read at all, which is its own reason a quote fails. */
const closedBrowser: BrowserRun = {
  fetch: () => { throw new Error('UnsupportedBrowserRunCall') },
  quickAction: async () => new Response('gone', { status: 410 }),
}

function brief(evidence: { quote: string; url: string }[] | undefined): DailyRecommendations {
  return DailyRecommendationsSchema.parse({
    id: 'recommendations-2026-09-02',
    links: [],
    model: 'claude-opus-5',
    publishedAt: '2026-09-02T13:30:00.000Z',
    recommendations: [{
      description: 'A signed agreement improves demand visibility.',
      direction: 'bullish',
      evidence,
      headline: 'Supply agreement improves visibility',
      recommendedOrder: { kind: 'legacy-unstructured', label: 'NVDA 225c 10/16' },
      risk: 'Delivery timing slips.',
      sources: [{ label: 'NVIDIA supply agreement', url: EVIDENCE_URL }],
      symbol: 'NVDA',
    }],
    regime: 'Selective',
    regimeDetail: 'Prefer company-specific catalysts.',
    sources: [{ label: 'NVIDIA supply agreement', url: EVIDENCE_URL }],
    summary: 'One falsifiable setup stands out.',
    title: 'Selective convexity',
  })
}

let store: SqliteD1Store

/** The member row exists in every case, because a publication records the account behind it. */
beforeEach(async () => {
  store = await migrationStore()
  seedMember(store, PUBLISHER)
})

afterEach(() => store.close())

/**
 * The standing brief a challenge runs against; there is none until a test publishes one.
 * `evidence` is passed at every call site rather than defaulted, because `undefined` is the
 * brief published before quotes were retained and a default would swallow that case.
 */
async function publishBrief(evidence: { quote: string; url: string }[] | undefined) {
  await dailyRecommendationsUpsertStatement(store.database, brief(evidence), PUBLISHER).run()
}

/** What the Worker's browser returns when the challenge re-reads the recommendation's sources. */
function challengeEnv(browser: BrowserRun = markdownBrowser(PAGE_MARKDOWN)) {
  return { BROWSER: browser, DB: store.database }
}

/** The verification as the site would read it back off the stored brief. */
async function storedVerification() {
  return (await readLatestDailyRecommendations(store.database))?.recommendations[0]?.verification
}

describe('challenging a published recommendation', () => {
  it('records that the quotes still stand when the page still carries them', async () => {
    await publishBrief(QUOTED_EVIDENCE)

    const result = await challengeRecommendation(challengeEnv(), 'NVDA', NOW)

    expect(result).toEqual({
      briefId: 'recommendations-2026-09-02',
      ran: true,
      status: 'checked',
      symbol: 'NVDA',
      verification: { checkedAt: NOW.toISOString(), reasons: [], status: 'holds' },
    })
    // The finding is on the brief, where the reader is, not only in the agent's answer.
    await expect(storedVerification())
      .resolves.toEqual({ checkedAt: NOW.toISOString(), reasons: [], status: 'holds' })
  })

  it('says the source no longer supports it, and why, when the page has moved on', async () => {
    await publishBrief(QUOTED_EVIDENCE)

    const rewritten = await challengeRecommendation(challengeEnv(markdownBrowser(REWRITTEN_PAGE)), 'NVDA', NOW)

    expect(rewritten).toMatchObject({ ran: true, status: 'checked' })
    if (rewritten.status !== 'checked') throw new Error('expected a completed check')
    expect(rewritten.verification.status).toBe('stale')
    expect(rewritten.verification.reasons).toEqual([`quote no longer in ${EVIDENCE_URL}: "${QUOTE}"`])
    await expect(storedVerification()).resolves.toMatchObject({ status: 'stale' })
  })

  it('names a page that will not open rather than reading its absence as a missing quote', async () => {
    await publishBrief(QUOTED_EVIDENCE)

    const closed = await challengeRecommendation(challengeEnv(closedBrowser), 'NVDA', NOW)

    if (closed.status !== 'checked') throw new Error('expected a completed check')
    expect(closed.verification).toEqual({
      checkedAt: NOW.toISOString(),
      reasons: [`source no longer opens: ${EVIDENCE_URL}`],
      status: 'stale',
    })
  })

  it('answers a repeat inside the window from the stored receipt, reading nothing', async () => {
    await publishBrief(QUOTED_EVIDENCE)
    await challengeRecommendation(challengeEnv(), 'NVDA', NOW)

    // A page that would say something else entirely: if it were read, the answer would change.
    const tooSoon = new Date(NOW.getTime() + RESEARCH_REFRESH_INTERVAL_MS - 1)
    const repeat = await challengeRecommendation(challengeEnv(markdownBrowser(REWRITTEN_PAGE)), 'NVDA', tooSoon)
    expect(repeat).toEqual({
      briefId: 'recommendations-2026-09-02',
      ran: false,
      status: 'checked',
      symbol: 'NVDA',
      verification: { checkedAt: NOW.toISOString(), reasons: [], status: 'holds' },
    })

    // Once the window is open the pages are read again, and the newer answer stands.
    const opens = new Date(NOW.getTime() + RESEARCH_REFRESH_INTERVAL_MS)
    const later = await challengeRecommendation(challengeEnv(markdownBrowser(REWRITTEN_PAGE)), 'NVDA', opens)
    expect(later).toMatchObject({ ran: true, status: 'checked' })
    await expect(storedVerification())
      .resolves.toMatchObject({ checkedAt: opens.toISOString(), status: 'stale' })
  })

  it('refuses to pretend a brief published before evidence was retained still holds', async () => {
    // A brief from before the quotes were kept: the field is absent, not empty.
    await publishBrief(undefined)

    await expect(challengeRecommendation(challengeEnv(), 'NVDA', NOW)).resolves.toEqual({
      briefId: 'recommendations-2026-09-02',
      reason: 'cannot be re-verified: published before evidence was retained',
      status: 'unverifiable',
      symbol: 'NVDA',
    })
    await expect(storedVerification()).resolves.toBeUndefined()
  })

  it('distinguishes a symbol the brief does not argue from a brief that does not exist', async () => {
    await expect(challengeRecommendation(challengeEnv(), 'NVDA', NOW))
      .resolves.toEqual({ status: 'no_brief' })

    await publishBrief(QUOTED_EVIDENCE)
    await expect(challengeRecommendation(challengeEnv(), 'AMD', NOW))
      .resolves.toEqual({ briefId: 'recommendations-2026-09-02', status: 'not_recommended', symbol: 'AMD' })
  })

  it('fails closed without the browser binding instead of answering from the store', async () => {
    await publishBrief(QUOTED_EVIDENCE)

    await expect(challengeRecommendation({ DB: store.database }, 'NVDA', NOW))
      .rejects.toThrow('RecommendationChallenge:page-reading-unavailable')
  })

  it('reads the cashtag an agent writes, and refuses anything that is not a symbol', async () => {
    await publishBrief(QUOTED_EVIDENCE)

    const tool = createRecommendationChallengeTool(challengeEnv(), NOW)
    await expect(tool.execute('call-1', { symbol: '$nvda' }))
      .resolves.toMatchObject({ details: { status: 'checked', symbol: 'NVDA' } })
    // The refusal names the check, never the value that failed it.
    await expect(tool.execute('call-2', { symbol: 'not-a-symbol' }))
      .resolves.toEqual({ content: [{ text: '{"error":"not a ticker symbol"}', type: 'text' }], details: { error: 'not a ticker symbol' } })
  })
})
