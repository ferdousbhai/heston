import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  resetDailyResearchAgent,
  setDailyResearchAgent,
  type DailyRecommendationsSubmission,
} from '../src/server/research-agent'
import { generateDailyRecommendations, shouldStartScheduledResearch } from '../src/server/research'
import { linksFromCandidates, recommendationsFromCandidates } from '../src/server/research-output'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { markdownBrowser } from './fake-browser'
import { migrationStore } from './sqlite-d1'

const NOW = new Date('2026-08-14T13:30:00.000Z')

/** What read_page retained for the cited source, so the binder has text to match against. */
function retainedPages(sourceUrl = EVIDENCE_URL) {
  return new Map([[sourceUrl, {
    markdown: '# NVIDIA\n\nThe company **signed a multi-year supply agreement** this week.',
    readAt: NOW.toISOString(),
  }]])
}
const EVIDENCE_URL = 'https://www.reuters.com/technology/nvidia-supply'

function submission(sourceUrl = EVIDENCE_URL): DailyRecommendationsSubmission {
  const report: DailyRecommendationsSubmission = {
    catalysts: [],
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
    links: [{
      description: 'Contains the signed agreement terms.',
      recommendationIndex: 0,
      sourceIndex: 0,
      title: 'NVIDIA supply agreement',
    }],
    regime: 'Selective',
    regimeDetail: 'Prefer company-specific catalysts with usable volatility.',
    sources: [{
      context: 'The agreement improves near-term demand visibility.',
      sourceUrl,
      title: 'NVIDIA supply agreement',
    }],
    summary: 'One falsifiable company-specific setup stands out.',
    title: 'Selective convexity',
  }
  return report
}

function response(
  report = submission(),
  retained = retainedPages(),
  catalysts: DailyRecommendationsSubmission['catalysts'] = [],
) {
  return Promise.resolve({ retained, submission: { ...report, catalysts } })
}

const broker = stubBroker()

beforeEach(() => {
  broker.tastyRequest.mockReset()
  broker.resolveResearchInstrumentCatalogFromTastytrade.mockClear()
  setBrokerApi(broker)
  setDailyResearchAgent({ run: () => response() })
})

afterEach(() => {
  resetBrokerApi()
  resetDailyResearchAgent()
})

describe('market-session research schedule', () => {
  it('starts once at 09:30 New York on weekdays', () => {
    expect(shouldStartScheduledResearch(new Date('2026-08-13T13:30:00.000Z'))).toBe(true)
    expect(shouldStartScheduledResearch(new Date('2026-08-13T13:40:00.000Z'))).toBe(false)
    expect(shouldStartScheduledResearch(new Date('2026-12-14T14:30:00.000Z'))).toBe(true)
    expect(shouldStartScheduledResearch(new Date('2026-08-15T13:30:00.000Z'))).toBe(false)
  })
})

describe('daily recommendation final boundary', () => {
  it('orders one structured reader link for each ranked recommendation', () => {
    const candidates = [2, 0, 1].map((recommendationIndex) => ({
      recommendationIndex,
      sourceIndex: recommendationIndex,
      description: `Why source ${recommendationIndex} matters.`,
      title: `Reference ${recommendationIndex}`,
    }))
    const evidence = Array.from({ length: 3 }, (_, sourceIndex) => ({
      label: `Raw source ${sourceIndex}`,
      url: `https://example.com/reference-${sourceIndex}`,
    }))

    const links = linksFromCandidates(candidates, evidence, 3)

    expect(links).toHaveLength(3)
    expect(links[0]).toEqual({
      description: 'Why source 0 matters.',
      title: 'Reference 0',
      url: 'https://example.com/reference-0',
    })
  })

  it('leaves a poor source choice visible for transcript auditing', () => {
    expect(linksFromCandidates([{
      description: 'Social post.',
      recommendationIndex: 0,
      sourceIndex: 0,
      title: 'X post',
    }], [{
      label: 'Social post',
      url: 'https://x.com/company/status/123',
    }], 1)).toEqual([{
      description: 'Social post.',
      title: 'X post',
      url: 'https://x.com/company/status/123',
    }])
  })

  it('refuses an impossible option expiry at the public recommendation boundary', () => {
    const recommendation = submission().recommendations[0]!
    const evidence = [{
      label: 'Independent wire · NVIDIA supply agreement',
      url: EVIDENCE_URL,
    }]

    expect(() => recommendationsFromCandidates([{
      ...recommendation,
      recommendedOrder: {
        kind: 'equity-option',
        legs: [{
          action: 'Buy to Open',
          contract: {
            expiry: '2027-02-31',
            optionType: 'C',
            strike: 225,
            underlying: 'NVDA',
          },
          instrumentType: 'Equity Option',
        }],
      },
    }], evidence)).toThrow('Use a real YYYY-MM-DD date')
  })

  it('preserves the model source selection without checking its editorial fit', () => {
    const recommendation = submission().recommendations[0]!
    const evidence = [
      {
        label: 'Independent wire · NVIDIA supply agreement',
        url: EVIDENCE_URL,
      },
      {
        label: 'Peer filing · Peer demand',
        url: 'https://example.com/peer-demand',
      },
    ]

    expect(recommendationsFromCandidates([{ ...recommendation, sourceIndices: [0, 1] }], evidence)[0]?.sources)
      .toEqual([
        { label: 'Independent wire · NVIDIA supply agreement', url: EVIDENCE_URL },
        { label: 'Peer filing · Peer demand', url: 'https://example.com/peer-demand' },
      ])
  })

  it('binds source references and publishes the typed model report unchanged', async () => {
    const result = await generateDailyRecommendations({}, NOW, { persist: false })

    expect(result.recommendations).toEqual([expect.objectContaining({
      direction: 'bullish',
      recommendedOrder: submission().recommendations[0]!.recommendedOrder,
      symbol: 'NVDA',
    })])
    expect(result.links).toEqual([expect.objectContaining({ url: EVIDENCE_URL })])
    expect(result.sources).toEqual([
      { label: 'NVIDIA supply agreement', url: EVIDENCE_URL },
      { label: 'NVIDIA supply agreement', url: EVIDENCE_URL },
    ])
    expect(broker.tastyRequest).not.toHaveBeenCalled()
    expect(broker.loadMarketSnapshot).not.toHaveBeenCalled()
  })

  it('commits the model catalyst, recommendation, and link updates together', async () => {
    const store = await migrationStore()
    const catalyst: DailyRecommendationsSubmission['catalysts'][number] = {
      date: '2026-09-15',
      description: null,
      kind: 'investor-event',
      sourceIndex: 0,
      symbol: 'NVDA',
      timing: 'unknown',
      title: 'NVIDIA investor event',
    }
    const retained = retainedPages()
    retained.set(EVIDENCE_URL, {
      markdown: '# NVIDIA\n\nThe company signed a multi-year supply agreement.\n\nThe investor event is September 15, 2026.',
      readAt: NOW.toISOString(),
    })
    setDailyResearchAgent({ run: () => response(submission(), retained, [catalyst]) })

    try {
      const result = await generateDailyRecommendations({
        BROWSER: markdownBrowser('unused by the stub agent'),
        DB: store.database,
      }, NOW)

      expect(store.sqlite.prepare(
        'SELECT source_provider, symbol FROM catalysts WHERE id = ?',
      ).get('daily-research:NVDA:investor-event:2026-09-15')).toEqual({
        source_provider: 'daily-research', symbol: 'NVDA',
      })
      expect(store.sqlite.prepare(
        'SELECT payload_json FROM daily_recommendations WHERE id = ?',
      ).get(result.id)).toEqual({ payload_json: JSON.stringify(result) })
      expect(store.sqlite.prepare(
        'SELECT title, description FROM recommendation_links WHERE url = ?',
      ).get(EVIDENCE_URL)).toEqual({
        description: 'Contains the signed agreement terms.',
        title: 'NVIDIA supply agreement',
      })
    } finally {
      store.close()
    }
  })

  it('maps the structured model source directly into the domain report', async () => {
    const nativeUrl = 'https://example.com/nvidia-primary#agreement'
    setDailyResearchAgent({
      run: () => response(submission(nativeUrl), retainedPages(nativeUrl)),
    })

    const result = await generateDailyRecommendations({}, NOW, { persist: false })
    expect(result.recommendations[0]?.sources).toEqual([{
      label: 'NVIDIA supply agreement',
      url: 'https://example.com/nvidia-primary',
    }])
  })

  it('refuses a non-HTTPS source before it can enter the public report', async () => {
    const sourceUrl = 'http://example.com/nvidia-primary'
    setDailyResearchAgent({ run: () => response(submission(sourceUrl), retainedPages(sourceUrl)) })

    await expect(generateDailyRecommendations({}, NOW, { persist: false }))
      .rejects.toThrow('invalid-source-url')
  })

  it('uses the narrow market-status read for scheduled runs', async () => {
    broker.tastyRequest.mockResolvedValueOnce({ data: { state: 'Pre-Market' } })

    await expect(generateDailyRecommendations({}, NOW, { persist: false, requireMarketOpen: true }))
      .rejects.toThrow('DailyResearchMarketNotOpen:Pre-Market')
    expect(broker.tastyRequest).toHaveBeenCalledWith(expect.anything(), '/market-time/equities/sessions/current')
    expect(broker.resolveResearchInstrumentCatalogFromTastytrade).not.toHaveBeenCalled()
    expect(broker.loadMarketSnapshot).not.toHaveBeenCalled()
  })

  it('retries only unresolved catalog identities after the market-open check', async () => {
    broker.tastyRequest.mockResolvedValueOnce({ data: { state: 'Open' } })
    broker.resolveResearchInstrumentCatalogFromTastytrade.mockResolvedValueOnce({
      missingSymbols: ['VXD'],
      receivedCount: 1,
      requestedCount: 2,
    })

    await generateDailyRecommendations({}, NOW, { persist: false, requireMarketOpen: true })

    expect(broker.resolveResearchInstrumentCatalogFromTastytrade).toHaveBeenCalledWith({}, NOW)
  })

  it('keeps research available when catalog identity repair is unavailable', async () => {
    broker.tastyRequest.mockResolvedValueOnce({ data: { state: 'Open' } })
    broker.resolveResearchInstrumentCatalogFromTastytrade
      .mockRejectedValueOnce(new Error('TastytradeApi:503:/instruments/equities'))

    await expect(generateDailyRecommendations({}, NOW, { persist: false, requireMarketOpen: true }))
      .resolves.toMatchObject({ id: 'recommendations-2026-08-14' })
  })

  it('replays with one transcript identity and publication time', async () => {
    const runIds: string[] = []
    setDailyResearchAgent({
      run: (_env, request) => {
        runIds.push(request.runId)
        return response()
      },
    })
    const cached = new Map<string, unknown>()
    const executed: string[] = []
    const runStep = async <T>(name: string, task: () => Promise<T>): Promise<T> => {
      if (cached.has(name)) {
        // SAFETY: deterministic Workflow step names replay with the original result type.
        return cached.get(name) as T
      }
      executed.push(name)
      const result = await task()
      cached.set(name, result)
      return result
    }

    const first = await generateDailyRecommendations({}, NOW, { persist: false, runStep })
    const replayed = await generateDailyRecommendations({}, NOW, { persist: false, runStep })

    expect(replayed.publishedAt).toBe(first.publishedAt)
    expect(runIds).toEqual([runIds[0], runIds[0]])
    // The citation binding needs no step of its own: it is a pure function of the retained
    // pages and the submission, both already memoized, so a replay reaches the same verdict.
    expect(executed).toEqual(['run-id', 'published-at'])
    expect(broker.tastyRequest).not.toHaveBeenCalled()
  })
})
