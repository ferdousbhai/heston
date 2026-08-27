import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { generateDailyResearch, shouldRunDailyResearch } from '../src/server/research'
import {
  resetMarketMoverResearch,
  setMarketMoverResearch,
  type MarketMoverResearch,
} from '../src/server/research-market-movers'
import {
  marketMoverInsightsFromCandidates,
  parseGeneratedResearch,
  redditCatalystsFromCandidates,
  researchIdeasForDate,
} from '../src/server/research-output'
import {
  resetResearchSources,
  setResearchSources,
  type ResearchSources,
} from '../src/server/research-sources'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { resetXCatalystResearch, setXCatalystResearch, type XCatalystResearch } from '../src/server/x-catalysts'
import { stubBroker } from './broker-stub'
import { unsupportedAi } from './fake-ai'
import { marketSnapshotFixture } from './fixtures/market'
import {
  resetInternalWatchlistWriter,
  setInternalWatchlistWriter,
  type InternalWatchlistWriter,
} from '../src/server/internal-watchlist'

const sources = {
  collectOfficialSources: vi.fn<ResearchSources['collectOfficialSources']>(async () => []),
  collectRedditSources: vi.fn<ResearchSources['collectRedditSources']>(async () => []),
  collectTickerSources: vi.fn<ResearchSources['collectTickerSources']>(async () => []),
} satisfies ResearchSources
const runXResearch = vi.fn<XCatalystResearch['runForSymbols']>(async () => ({ catalysts: [], rejected: 0 }))
const xResearch = { runForSymbols: runXResearch } satisfies XCatalystResearch
const collectMarketMovers = vi.fn<MarketMoverResearch['collect']>(async () => [])
const marketMovers = { collect: collectMarketMovers } satisfies MarketMoverResearch
const broker = stubBroker()
const secret: SecretsStoreSecret = { get: async () => 'secret' }
const internalWatchlist = { ensureSymbols: vi.fn() } satisfies InternalWatchlistWriter

function generatedResearch() {
  const marketMovers: Array<{
    description: string
    headline: string
    sourceIndices: number[]
    symbol: string
  }> = []
  return {
    title: 'Daily brief', summary: 'Summary', regime: 'Selective', regimeDetail: 'Defined risk',
    ideas: [{
      symbol: 'NVDA', direction: 'Cautiously bullish', headline: 'Breadth keeps improving',
      description: 'Participation is broadening. Cheap index premium keeps convexity accessible.',
      play: 'NVDA 225c 10/16', risk: 'Breadth reverses while the index stalls.',
      recentCoverageIndices: [], sourceIndices: [0], thesisChange: '',
    }],
    marketMovers,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  broker.loadMarketSnapshot.mockResolvedValue(marketSnapshotFixture())
  setBrokerApi(broker)
  setResearchSources(sources)
  setXCatalystResearch(xResearch)
  setMarketMoverResearch(marketMovers)
  internalWatchlist.ensureSymbols.mockReset().mockImplementation(async (_env, symbols) => [...symbols])
  setInternalWatchlistWriter(internalWatchlist)
})

afterEach(() => {
  resetBrokerApi()
  resetResearchSources()
  resetXCatalystResearch()
  resetMarketMoverResearch()
  resetInternalWatchlistWriter()
})

describe('daily research schedule', () => {
  it('runs at 09:30 New York time during daylight saving time', () => {
    expect(shouldRunDailyResearch(new Date('2026-08-13T13:30:00.000Z'))).toBe(true)
    expect(shouldRunDailyResearch(new Date('2026-08-13T14:30:00.000Z'))).toBe(false)
  })

  it('runs at 09:30 New York time during standard time', () => {
    expect(shouldRunDailyResearch(new Date('2026-12-14T14:30:00.000Z'))).toBe(true)
    expect(shouldRunDailyResearch(new Date('2026-12-14T13:30:00.000Z'))).toBe(false)
  })

  it('does not generate weekend issues', () => {
    expect(shouldRunDailyResearch(new Date('2026-08-15T13:30:00.000Z'))).toBe(false)
  })
})

describe('daily intelligence pipeline', () => {
  it('starts X, Reddit, and market-mover research together before editing the brief', async () => {
    let releaseReddit!: (items: []) => void
    let releaseX!: (result: { catalysts: []; rejected: number }) => void
    let releaseMovers!: (items: []) => void
    sources.collectRedditSources.mockImplementationOnce(() => new Promise((resolve) => { releaseReddit = resolve }))
    runXResearch.mockImplementationOnce(() => new Promise((resolve) => { releaseX = resolve }))
    collectMarketMovers.mockImplementationOnce(() => new Promise((resolve) => { releaseMovers = resolve }))
    const run = vi.fn().mockResolvedValue({ output_text: JSON.stringify(generatedResearch()) })

    const pending = generateDailyResearch({
      AI: { ...unsupportedAi(), run },
      REDDIT_CLIENT_ID: secret,
      REDDIT_CLIENT_SECRET: secret,
    }, new Date('2026-08-14T13:30:00.000Z'))

    await vi.waitFor(() => {
      expect(sources.collectRedditSources).toHaveBeenCalledOnce()
      expect(runXResearch).toHaveBeenCalledOnce()
      expect(collectMarketMovers).toHaveBeenCalledOnce()
    })
    expect(run).not.toHaveBeenCalled()
    releaseReddit([])
    releaseX({ catalysts: [], rejected: 0 })
    releaseMovers([])
    await expect(pending).resolves.toMatchObject({ id: 'brief-2026-08-14' })
  })

  it('skips catalyst extraction when discussion has no bound focus symbol', async () => {
    sources.collectRedditSources.mockResolvedValueOnce([{
      context: 'A broad market conversation without a watched company.',
      source: 'Reddit · r/wallstreetbets',
      title: 'General market discussion',
      url: 'https://www.reddit.com/r/wallstreetbets/comments/abc123/general_discussion/',
    }])
    const output = generatedResearch()
    output.ideas = []
    const run = vi.fn().mockResolvedValue({ output_text: JSON.stringify(output) })

    await generateDailyResearch({
      AI: { ...unsupportedAi(), run },
      REDDIT_CLIENT_ID: secret,
      REDDIT_CLIENT_SECRET: secret,
    }, new Date('2026-08-14T13:30:00.000Z'))

    expect(run).toHaveBeenCalledOnce()
    expect(sources.collectTickerSources).toHaveBeenCalledWith([], new Date('2026-08-14T13:30:00.000Z'))
  })

  it('uses a strict Responses API schema and never exposes position provenance', async () => {
    const xUrl = 'https://x.com/nvidia/status/1234567890'
    runXResearch.mockResolvedValueOnce({
      rejected: 0,
      catalysts: [{
        id: 'xai-x-search:NVDA:product-event:2026-09-01',
        symbol: 'NVDA', kind: 'product-event', title: 'NVIDIA product event',
        description: 'NVIDIA scheduled an accelerator launch event.', date: '2026-09-01',
        timing: 'intraday', confidence: 'confirmed', source: 'Grok 4.6 X research',
        sourceUrl: xUrl, updatedAt: '2026-08-14T13:30:00.000Z',
      }],
    })
    collectMarketMovers.mockResolvedValueOnce([{
      context: 'PLTR is up 8.41%. A contract headline is a possible driver.',
      marketMover: {
        averageVolume3Month: 42_100_000, category: 'gainer', changePercent: 8.41,
        name: 'Palantir Technologies', price: 184.27, symbol: 'PLTR', volume: 79_200_000,
      },
      outbound: { label: 'Reuters · Palantir wins new contract', url: 'https://www.reuters.com/technology/palantir-contract' },
      source: 'Yahoo Finance market movers', title: 'PLTR +8.41% · Palantir wins new contract',
      url: 'https://finance.yahoo.com/quote/PLTR',
    }])
    const discoveryUrl = 'https://www.reddit.com/r/wallstreetbets/comments/abc123/nvda_discussion/'
    sources.collectRedditSources.mockResolvedValueOnce([{
      context: 'NVDA demand is drawing renewed attention.',
      source: 'Reddit · r/wallstreetbets', symbols: ['NVDA'], title: 'NVDA demand discussion',
      url: discoveryUrl,
    }])
    sources.collectTickerSources.mockResolvedValueOnce([{
      context: 'Reuters reports a new NVIDIA supply agreement.',
      outbound: { label: 'Reuters · NVIDIA supply agreement', url: 'https://www.reuters.com/technology/nvidia-supply' },
      publishedAt: '2026-08-14T12:00:00.000Z', source: 'Yahoo Finance ticker research',
      symbols: ['NVDA'], title: 'NVDA · NVIDIA supply agreement', url: 'https://finance.yahoo.com/quote/NVDA',
    }])
    const output = generatedResearch()
    output.marketMovers = [{
      symbol: 'PLTR', sourceIndices: [2], headline: 'Contract news may explain the spike',
      description: 'Palantir rose on heavy volume. The reported contract is a possible driver.',
    }]
    const run = vi.fn().mockImplementation(async (_model, options) => ({
      output: [{
        type: 'message',
        content: [{
          type: 'output_text',
          text: JSON.stringify(options.text.format.name === 'spice_reddit_catalysts' ? { catalysts: [] } : output),
        }],
      }],
    }))
    const brief = await generateDailyResearch({
      AI: { ...unsupportedAi(), run },
      REDDIT_CLIENT_ID: secret,
      REDDIT_CLIENT_SECRET: secret,
    }, new Date('2026-08-14T13:30:00.000Z'))

    const briefCall = run.mock.calls.find((call) => call[1].text.format.name === 'spice_daily_intelligence')
    expect(briefCall?.[0]).toBe('@cf/openai/gpt-oss-120b')
    expect(briefCall?.[1]).toMatchObject({
      text: { format: { type: 'json_schema', name: 'spice_daily_intelligence', strict: true } },
    })
    expect(briefCall?.[2]).toMatchObject({
      gateway: {
        collectLog: true,
        id: 'spice',
        metadata: { app: 'spice', feature: 'daily-research', market_date: '2026-08-14' },
        skipCache: true,
      },
      tags: ['spice', 'daily-research'],
    })
    expect(JSON.stringify(briefCall?.[1]?.text?.format.schema)).not.toContain('uniqueItems')
    const modelRequest = JSON.stringify(briefCall?.[1])
    expect(modelRequest).toContain(xUrl)
    expect(modelRequest).toContain('NVIDIA')
    expect(modelRequest).not.toContain(discoveryUrl)
    expect(modelRequest.toLowerCase()).not.toContain('reddit')
    expect(modelRequest).not.toContain('"position"')
    expect(modelRequest).not.toContain('Active Positions')
    expect(brief.ideas[0]?.direction).toBe('bullish')
    expect(brief.ideas[0]?.play).toBe('NVDA 225c 10/16')
    expect(brief.marketMovers).toEqual([expect.objectContaining({
      symbol: 'PLTR', changePercent: 8.41, headline: 'Contract news may explain the spike',
    })])
    expect(internalWatchlist.ensureSymbols).toHaveBeenCalledWith(
      expect.anything(), ['NVDA', 'PLTR'], 'scheduled-research', new Date('2026-08-14T13:30:00.000Z'),
    )
    expect(brief.sources).toContainEqual({ label: 'Grok 4.6 X research · NVIDIA product event', url: xUrl })
    expect(brief.sources.some((source) => source.url === discoveryUrl)).toBe(false)
  })

  it('rejects ideas for watched symbols that lack complete tastytrade metrics', async () => {
    const snapshot = marketSnapshotFixture()
    snapshot.tickers = snapshot.tickers.filter((ticker) => ticker.symbol !== 'NVDA')
    broker.loadMarketSnapshot.mockResolvedValueOnce(snapshot)
    sources.collectOfficialSources.mockResolvedValueOnce([{
      context: 'NVIDIA published an update.',
      source: 'Official source',
      symbols: ['NVDA'],
      title: 'NVIDIA update',
      url: 'https://example.com/nvda',
    }])
    const run = vi.fn().mockResolvedValue({ output_text: JSON.stringify(generatedResearch()) })

    const brief = await generateDailyResearch({
      AI: { ...unsupportedAi(), run },
      REDDIT_CLIENT_ID: secret,
      REDDIT_CLIENT_SECRET: secret,
    }, new Date('2026-08-14T13:30:00.000Z'))

    expect(brief.ideas).toEqual([])
  })

  it('binds Reddit catalyst candidates to watched symbols and exact post provenance', () => {
    const evidence = [{
      source: 'Reddit · r/wallstreetbets',
      title: 'NVDA event discussion',
      url: 'https://www.reddit.com/r/wallstreetbets/comments/abc123/nvda_event/',
      context: 'NVIDIA says its product event is September 1.',
      symbols: ['NVDA'],
    }]
    const candidates = [{
      sourceIndex: 0, symbol: 'NVDA', kind: 'product-event', title: 'NVIDIA product event',
      description: 'NVIDIA scheduled a product event that may reprice accelerator expectations.',
      date: '2026-09-01', timing: 'intraday',
    }]

    expect(redditCatalystsFromCandidates(candidates, evidence, ['NVDA'], new Date('2026-08-14T13:30:00Z')))
      .toEqual([expect.objectContaining({
        id: 'reddit:abc123:NVDA:product-event:2026-09-01',
        confidence: 'estimated',
        description: candidates[0]!.description,
        sourceUrl: evidence[0]!.url,
      })])
    expect(redditCatalystsFromCandidates(candidates, evidence, ['META'], new Date('2026-08-14T13:30:00Z')))
      .toEqual([])
    expect(redditCatalystsFromCandidates(candidates, [{ ...evidence[0]!, symbols: ['META'] }], ['NVDA'], new Date('2026-08-14T13:30:00Z')))
      .toEqual([])
  })

  it('binds mover explanations to same-symbol evidence and falls back when the editor crosses sources', () => {
    const evidence = [{
      source: 'Yahoo Finance market movers', title: 'PLTR +8.41%', url: 'https://finance.yahoo.com/quote/PLTR',
      marketMover: {
        category: 'gainer' as const, changePercent: 8.41, name: 'Palantir', price: 184.27,
        symbol: 'PLTR', volume: 79_200_000,
      },
    }, {
      source: 'Yahoo Finance market movers', title: 'INTC -6.1%', url: 'https://finance.yahoo.com/quote/INTC',
      marketMover: {
        category: 'loser' as const, changePercent: -6.1, name: 'Intel', price: 29.2,
        symbol: 'INTC', volume: 61_000_000,
      },
    }]
    const result = marketMoverInsightsFromCandidates([{
      symbol: 'PLTR', sourceIndices: [1], headline: 'Wrong source', description: 'This must not be trusted.',
    }], evidence)

    expect(result).toHaveLength(2)
    expect(result).toContainEqual(expect.objectContaining({
      symbol: 'PLTR', headline: 'Move detected; driver not established',
    }))
    expect(result).toContainEqual(expect.objectContaining({
      symbol: 'INTC', headline: 'Move detected; driver not established',
    }))
  })

  it('rejects impossible and out-of-horizon model play dates in deterministic code', () => {
    const idea = {
      ...generatedResearch().ideas[0]!,
      direction: 'bullish' as const,
    }
    const evidence = [{
      source: 'Example', symbols: ['NVDA'], title: 'NVIDIA update', url: 'https://example.com/nvda',
    }]
    const {
      recentCoverageIndices: _recentCoverageIndices,
      sourceIndices: _sourceIndices,
      thesisChange: _thesisChange,
      ...ideaWithoutIndices
    } = idea
    const accepted = { ...ideaWithoutIndices, sources: [{ label: 'Example · NVIDIA update', url: 'https://example.com/nvda' }] }
    expect(researchIdeasForDate([
      { ...idea, play: 'NVDA 225c 2/30' },
      { ...idea, play: 'NVDA 225c 8/20' },
      { ...idea, play: 'NVDA 225c 12/31' },
      idea,
    ], '2026-08-14', evidence, ['NVDA'])).toEqual([accepted])

    expect(researchIdeasForDate([{ ...idea, play: 'NVDA 225c 1/15' }], '2026-12-01', evidence, ['NVDA']))
      .toEqual([{ ...accepted, play: 'NVDA 225c 1/15' }])
    expect(researchIdeasForDate([idea], '2026-08-14', [{ ...evidence[0], symbols: ['SPCX'] }], ['NVDA']))
      .toEqual([])
  })

  it('accepts a play only when its date can be an option expiration', () => {
    const idea = { ...generatedResearch().ideas[0]!, direction: 'bullish' as const }
    const evidence = [{
      source: 'Example', symbols: ['NVDA'], title: 'NVIDIA update', url: 'https://example.com/nvda',
    }]
    const acceptedPlays = (today: string, ...plays: string[]) => researchIdeasForDate(
      plays.map((play) => ({ ...idea, play })), today, evidence, ['NVDA'],
    ).map((accepted) => accepted.play)

    // A production brief shipped two plays expiring Sunday 2026-09-20.
    expect(acceptedPlays('2026-08-14', 'NVDA 225c 9/20', 'NVDA 225c 9/19', 'NVDA 225c 9/17')).toEqual([])
    expect(acceptedPlays('2026-08-14', 'NVDA 225c 9/18', 'NVDA 225c 10/16'))
      .toEqual(['NVDA 225c 9/18', 'NVDA 225c 10/16'])
    // Christmas Day 2026 is a Friday, so that week's options expire Thursday 12/24.
    expect(acceptedPlays('2026-10-20', 'NVDA 225c 12/25', 'NVDA 225c 12/24')).toEqual(['NVDA 225c 12/24'])
  })

  it('requires every recent same-symbol coverage row and newer evidence for a changed thesis', () => {
    const base = { ...generatedResearch().ideas[0]!, direction: 'bullish' as const }
    const evidence = [{
      publishedAt: '2026-08-14T12:00:00.000Z', source: 'Independent wire', symbols: ['NVDA'],
      title: 'NVIDIA supply agreement', url: 'https://example.com/nvda',
    }]
    const recentCoverage = [{
      description: base.description,
      direction: 'bullish' as const,
      headline: base.headline,
      publishedAt: '2026-08-12T13:30:00.000Z',
      risk: base.risk,
      symbol: 'NVDA',
    }]
    const changed = {
      ...base,
      description: 'A signed supply agreement improves near-term visibility. The contracted volume changes the demand evidence.',
      headline: 'Signed supply agreement changes demand visibility',
      recentCoverageIndices: [0],
      thesisChange: 'The prior thesis relied on breadth; a signed supply agreement now adds company-specific demand evidence.',
    }

    expect(researchIdeasForDate([base], '2026-08-14', evidence, ['NVDA'], recentCoverage)).toEqual([])
    expect(researchIdeasForDate([
      { ...changed, recentCoverageIndices: [] },
    ], '2026-08-14', evidence, ['NVDA'], recentCoverage)).toEqual([])
    expect(researchIdeasForDate([changed], '2026-08-14', [
      { ...evidence[0], publishedAt: '2026-08-11T12:00:00.000Z' },
    ], ['NVDA'], recentCoverage)).toEqual([])
    expect(researchIdeasForDate([changed], '2026-08-14', evidence, ['NVDA'], recentCoverage))
      .toEqual([expect.objectContaining({
        description: changed.description,
        headline: changed.headline,
        sources: [{ label: 'Independent wire · NVIDIA supply agreement', url: 'https://example.com/nvda' }],
      })])
  })

  it('does not publish discovery-provider names in an idea', () => {
    const idea = {
      ...generatedResearch().ideas[0]!,
      description: 'Reddit attention supports the setup. Premium remains affordable.',
      direction: 'bullish' as const,
    }
    const evidence = [{
      source: 'Independent wire', symbols: ['NVDA'], title: 'NVIDIA update', url: 'https://example.com/nvda',
    }]
    expect(researchIdeasForDate([idea], '2026-08-14', evidence, ['NVDA'])).toEqual([])
  })

  it('caps generated Daily Read output at three theses', () => {
    const output = generatedResearch()
    output.ideas = Array.from({ length: 4 }, () => ({ ...output.ideas[0]! }))
    expect(() => parseGeneratedResearch({ output_text: JSON.stringify(output) })).toThrow()
  })

  it('cites the fetched article that supplied an idea instead of its aggregator page', () => {
    const idea = { ...generatedResearch().ideas[0]!, direction: 'bullish' as const }
    const evidence = [{
      source: 'Yahoo Finance market movers', symbols: ['NVDA'], title: 'NVDA +4.2% · supply update',
      url: 'https://finance.yahoo.com/quote/NVDA',
      outbound: { label: 'Reuters · NVIDIA supply update', url: 'https://www.reuters.com/technology/nvidia-supply' },
    }]

    expect(researchIdeasForDate([idea], '2026-08-14', evidence, ['NVDA'])[0]?.sources).toEqual([
      evidence[0]!.outbound,
    ])
  })
})
