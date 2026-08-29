import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  resetDailyResearchAgent,
  setDailyResearchAgent,
  type DailyResearchSubmission,
} from '../src/server/research-agent'
import { generateDailyResearch, shouldStartScheduledResearch } from '../src/server/research'
import { readingListFromCandidates, researchIdeas } from '../src/server/research-output'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'

const NOW = new Date('2026-08-14T13:30:00.000Z')
const EVIDENCE_URL = 'https://www.reuters.com/technology/nvidia-supply'

function submission(sourceUrl = EVIDENCE_URL): DailyResearchSubmission {
  const report: DailyResearchSubmission = {
    ideas: [{
      description: 'A signed agreement improves demand visibility while volatility remains usable.',
      direction: 'bullish',
      headline: 'Supply agreement improves visibility',
      play: { expiration: '2026-10-16', optionType: 'call', strike: 225 },
      risk: 'Delivery timing slips or volume fails to convert to revenue.',
      sourceIndices: [0],
      symbol: 'NVDA',
    }],
    readingList: [{
      description: 'Contains the signed agreement terms.',
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

function response(report = submission()) {
  return Promise.resolve({ submission: report })
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

describe('daily research final boundary', () => {
  it('publishes the six structured reading links without filtering or rewriting them', () => {
    const candidates = Array.from({ length: 6 }, (_, sourceIndex) => ({
      description: `Why source ${sourceIndex} matters.`,
      sourceIndex,
      title: `Reference ${sourceIndex}`,
    }))
    const evidence = candidates.map(({ sourceIndex }) => ({
      label: `Raw source ${sourceIndex}`,
      url: `https://example.com/reference-${sourceIndex}`,
    }))

    const links = readingListFromCandidates(candidates, evidence)

    expect(links).toHaveLength(6)
    expect(links[0]).toEqual({
      reason: 'Why source 0 matters.',
      title: 'Reference 0',
      url: 'https://example.com/reference-0',
    })
  })

  it('leaves a poor source choice visible for transcript auditing', () => {
    expect(readingListFromCandidates([{
      description: 'Social post.',
      sourceIndex: 0,
      title: 'X post',
    }], [{
      label: 'Social post',
      url: 'https://x.com/company/status/123',
    }])).toEqual([{
      reason: 'Social post.',
      title: 'X post',
      url: 'https://x.com/company/status/123',
    }])
  })

  it('renders the model option expression without a second validation pass', () => {
    const idea = submission().ideas[0]!
    const evidence = [{
      label: 'Independent wire · NVIDIA supply agreement',
      url: EVIDENCE_URL,
    }]

    expect(researchIdeas([
      { ...idea, play: { ...idea.play!, expiration: '2027-02-31' } },
    ], evidence)[0]?.play).toBe('NVDA 225c 2/31')
  })

  it('preserves the model source selection without checking its editorial fit', () => {
    const idea = submission().ideas[0]!
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

    expect(researchIdeas([{ ...idea, sourceIndices: [0, 1] }], evidence)[0]?.sources)
      .toEqual([
        { label: 'Independent wire · NVIDIA supply agreement', url: EVIDENCE_URL },
        { label: 'Peer filing · Peer demand', url: 'https://example.com/peer-demand' },
      ])
  })

  it('binds source references and publishes the typed model report unchanged', async () => {
    const brief = await generateDailyResearch({}, NOW, { persist: false })

    expect(brief.ideas).toEqual([expect.objectContaining({
      direction: 'bullish',
      play: 'NVDA 225c 10/16',
      symbol: 'NVDA',
    })])
    expect(brief.readingList).toEqual([expect.objectContaining({ url: EVIDENCE_URL })])
    expect(brief.sources).toEqual([
      { label: 'NVIDIA supply agreement', url: EVIDENCE_URL },
      { label: 'NVIDIA supply agreement', url: EVIDENCE_URL },
    ])
    expect(broker.tastyRequest).not.toHaveBeenCalled()
    expect(broker.loadMarketSnapshot).not.toHaveBeenCalled()
  })

  it('maps the structured model source directly into the domain report', async () => {
    const nativeUrl = 'https://example.com/nvidia-primary#agreement'
    setDailyResearchAgent({
      run: () => response(submission(nativeUrl)),
    })

    const brief = await generateDailyResearch({}, NOW, { persist: false })
    expect(brief.ideas[0]?.sources).toEqual([{
      label: 'NVIDIA supply agreement',
      url: nativeUrl,
    }])
  })

  it('lets the report domain schema reject a non-HTTPS structured source', async () => {
    setDailyResearchAgent({ run: () => response(submission('http://example.com/nvidia-primary')) })

    await expect(generateDailyResearch({}, NOW, { persist: false }))
      .rejects.toThrow('Use an HTTPS source URL')
  })

  it('uses the narrow market-status read for scheduled runs', async () => {
    broker.tastyRequest.mockResolvedValueOnce({ data: { state: 'pre' } })

    await expect(generateDailyResearch({}, NOW, { persist: false, requireMarketOpen: true }))
      .rejects.toThrow('DailyResearchMarketNotOpen:pre')
    expect(broker.tastyRequest).toHaveBeenCalledWith(expect.anything(), '/market-time/equities/sessions/current')
    expect(broker.resolveResearchInstrumentCatalogFromTastytrade).not.toHaveBeenCalled()
    expect(broker.loadMarketSnapshot).not.toHaveBeenCalled()
  })

  it('retries only unresolved catalog identities after the market-open check', async () => {
    broker.tastyRequest.mockResolvedValueOnce({ data: { state: 'open' } })
    broker.resolveResearchInstrumentCatalogFromTastytrade.mockResolvedValueOnce({
      missingSymbols: ['VXD'],
      receivedCount: 1,
      requestedCount: 2,
    })

    await generateDailyResearch({}, NOW, { persist: false, requireMarketOpen: true })

    expect(broker.resolveResearchInstrumentCatalogFromTastytrade).toHaveBeenCalledWith({}, NOW)
  })

  it('keeps research available when catalog identity repair is unavailable', async () => {
    broker.tastyRequest.mockResolvedValueOnce({ data: { state: 'open' } })
    broker.resolveResearchInstrumentCatalogFromTastytrade
      .mockRejectedValueOnce(new Error('TastytradeApi:503:/instruments/equities'))

    await expect(generateDailyResearch({}, NOW, { persist: false, requireMarketOpen: true }))
      .resolves.toMatchObject({ id: 'brief-2026-08-14' })
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

    const first = await generateDailyResearch({}, NOW, { persist: false, runStep })
    const replayed = await generateDailyResearch({}, NOW, { persist: false, runStep })

    expect(replayed.publishedAt).toBe(first.publishedAt)
    expect(runIds).toEqual([runIds[0], runIds[0]])
    expect(executed).toEqual(['run-id', 'published-at'])
    expect(broker.tastyRequest).not.toHaveBeenCalled()
  })
})
