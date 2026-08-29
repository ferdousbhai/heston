import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  resetDailyResearchAgent,
  setDailyResearchAgent,
  type DailyResearchSubmission,
} from '../src/server/research-agent'
import { generateDailyResearch, shouldRunDailyResearch } from '../src/server/research'
import { researchIdeas } from '../src/server/research-output'
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
    readingList: [{ reason: 'Contains the signed agreement terms.', sourceIndex: 0 }],
    regime: 'Selective',
    regimeDetail: 'Prefer company-specific catalysts with usable volatility.',
    sources: [{ evidenceIndex: 0, symbol: 'NVDA' }],
    summary: 'One falsifiable company-specific setup stands out.',
    title: 'Selective convexity',
  }
  if (sourceUrl !== EVIDENCE_URL) report.sources = [{
    context: 'The agreement improves near-term demand visibility.',
    evidenceIndex: null,
    sourceUrl,
    symbol: 'NVDA',
    title: 'NVIDIA supply agreement',
  }]
  return report
}

function chainRow() {
  return {
    active: true,
    'expiration-date': '2026-10-16',
    'instrument-type': 'Equity Option',
    'is-closing-only': false,
    'option-chain-type': 'Standard',
    'option-type': 'C',
    'root-symbol': 'NVDA',
    'shares-per-contract': 100,
    'streamer-symbol': '.NVDA261016C225',
    'strike-price': '225',
    symbol: 'NVDA  261016C00225000',
    'underlying-symbol': 'NVDA',
  }
}

function response(report = submission(), citations = new Set<string>()) {
  return Promise.resolve({
    citations,
    evidence: [{
      context: 'NVDA: NVIDIA signed a new supply agreement.',
      evidenceIndex: 0,
      source: 'Linked-page discovery · reuters.com',
      title: 'NVIDIA supply agreement',
      url: EVIDENCE_URL,
    }],
    marketMetrics: [{
      impliedVolatilityIndex: 42,
      impliedVolatilityPercentile: 38,
      impliedVolatilityRank: 27,
      liquidityRating: 5,
      symbol: 'NVDA',
    }],
    submission: report,
    webSearches: 1,
    xSearches: 1,
  })
}

const broker = stubBroker()

beforeEach(() => {
  broker.tastyRequest.mockReset().mockResolvedValue({ data: { items: [chainRow()] } })
  setBrokerApi(broker)
  setDailyResearchAgent({ run: () => response() })
})

afterEach(() => {
  resetBrokerApi()
  resetDailyResearchAgent()
})

describe('daily research schedule', () => {
  it('starts once at 09:30 New York on weekdays', () => {
    expect(shouldRunDailyResearch(new Date('2026-08-13T13:30:00.000Z'))).toBe(true)
    expect(shouldRunDailyResearch(new Date('2026-08-13T13:40:00.000Z'))).toBe(false)
    expect(shouldRunDailyResearch(new Date('2026-12-14T14:30:00.000Z'))).toBe(true)
    expect(shouldRunDailyResearch(new Date('2026-08-15T13:30:00.000Z'))).toBe(false)
  })
})

describe('daily research final boundary', () => {
  it('lets the agent choose any real expiry before exact chain verification', () => {
    const idea = submission().ideas[0]!
    const evidence = [{
      context: 'NVDA signed a new supply agreement.',
      source: 'Independent wire',
      symbols: ['NVDA'],
      title: 'NVIDIA supply agreement',
      url: EVIDENCE_URL,
    }]

    expect(researchIdeas([
      { ...idea, play: { ...idea.play!, expiration: '2027-01-15' } },
    ], evidence, ['NVDA'])[0]?.contract).toMatchObject({ expiry: '2027-01-15' })
  })

  it('binds an agent-selected symbol to fetched evidence and verifies its exact option', async () => {
    const brief = await generateDailyResearch({}, NOW, { persist: false })

    expect(brief.ideas).toEqual([expect.objectContaining({
      direction: 'bullish',
      play: 'NVDA 225c 10/16',
      symbol: 'NVDA',
    })])
    expect(brief.readingList).toEqual([expect.objectContaining({ url: EVIDENCE_URL })])
    expect(brief.sources).toEqual([
      { label: 'tastytrade market metrics', url: 'https://developer.tastytrade.com/open-api-spec/market-metrics/' },
      { label: 'Linked-page discovery · reuters.com · NVIDIA supply agreement', url: EVIDENCE_URL },
    ])
    expect(broker.tastyRequest).toHaveBeenCalledWith(expect.anything(), '/option-chains/NVDA')
    expect(broker.loadMarketSnapshot).not.toHaveBeenCalled()
  })

  it('accepts a native-search link only when it appears in provider citation metadata', async () => {
    const nativeUrl = 'https://example.com/nvidia-primary'
    setDailyResearchAgent({
      run: () => response(submission(nativeUrl), new Set([nativeUrl])),
    })

    const brief = await generateDailyResearch({}, NOW, { persist: false })
    expect(brief.ideas[0]?.sources).toEqual([{
      label: 'Grok research · example.com · NVIDIA supply agreement',
      url: nativeUrl,
    }])
  })

  it('uses the narrow market-status read for scheduled runs', async () => {
    broker.tastyRequest.mockResolvedValueOnce({ data: { state: 'pre' } })

    await expect(generateDailyResearch({}, NOW, { persist: false, requireMarketOpen: true }))
      .rejects.toThrow('DailyResearchMarketNotOpen:pre')
    expect(broker.tastyRequest).toHaveBeenCalledWith(expect.anything(), '/market-time/equities/sessions/current')
    expect(broker.loadMarketSnapshot).not.toHaveBeenCalled()
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
    expect(executed).toEqual(['run-id', 'verify-option-chains', 'published-at'])
    expect(broker.tastyRequest).toHaveBeenCalledTimes(1)
  })
})
