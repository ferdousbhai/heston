import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { z } from 'zod'

import { type Catalyst } from '../src/domain/catalyst'
import { generateDailyResearch, shouldRunDailyResearch } from '../src/server/research'
import { type ResearchSourceItem } from '../src/server/research-contracts'
import {
  resetMarketMoverResearch,
  setMarketMoverResearch,
  type MarketMoverResearch,
} from '../src/server/research-market-movers'
import {
  marketMoverInsightsFromCandidates,
  marketMoverPacket,
  mentionsDiscoverySource,
  parseGeneratedRedditCatalysts,
  parseGeneratedResearch,
  redditCatalystsFromCandidates,
  researchIdeasForDate,
  researchPlayTuple,
  UNCONFIRMED_MOVER_HEADLINE,
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
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'
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

function chainRow(fields: Partial<{
  'expiration-date': string
  'option-type': 'C' | 'P'
  'strike-price': string
}> = {}) {
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
    ...fields,
  }
}

function optionChain(...rows: ReturnType<typeof chainRow>[]) {
  return { data: { items: rows } }
}

function nvdaEvidence() {
  sources.collectRedditSources.mockResolvedValueOnce([{
    context: 'NVDA demand is drawing renewed attention.',
    source: 'Reddit · r/wallstreetbets', symbols: ['NVDA'], title: 'NVDA demand discussion',
    url: 'https://www.reddit.com/r/wallstreetbets/comments/abc123/nvda_discussion/',
  }])
  sources.collectTickerSources.mockResolvedValueOnce([{
    context: 'Reuters reports a new NVIDIA supply agreement.',
    publishedAt: '2026-08-14T12:00:00.000Z', source: 'Yahoo Finance ticker research',
    symbols: ['NVDA'], title: 'NVDA · NVIDIA supply agreement', url: 'https://finance.yahoo.com/quote/NVDA',
  }])
}

function promptFor(run: Mock, name: string): string {
  return String(run.mock.calls.find((call) => call[1].text.format.name === name)?.[1].input[1].content)
}

function promptSection(prompt: string, label: string, next: string): string {
  return prompt.split(label)[1]!.split(next)[0]!
}

function briefEvidencePacketJson(briefPrompt: string): string {
  return promptSection(briefPrompt, 'cite an item by copying its own index field: ', '. Recent ticker coverage')
}

async function runDailyBrief() {
  const run = vi.fn().mockImplementation(async (_model, options) => ({
    output_text: JSON.stringify(
      options.text.format.name === 'spice_reddit_catalysts' ? { catalysts: [] } : generatedResearch(),
    ),
  }))
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  try {
    const brief = await generateDailyResearch({
      AI: { ...unsupportedAi(), run },
      REDDIT_CLIENT_ID: secret,
      REDDIT_CLIENT_SECRET: secret,
    }, new Date('2026-08-14T13:30:00.000Z'))
    const logged: unknown[] = info.mock.calls.map((call) => JSON.parse(String(call[0])))
    return { brief, briefPrompt: promptFor(run, 'spice_daily_intelligence'), logged }
  } finally {
    info.mockRestore()
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  broker.loadMarketSnapshot.mockResolvedValue(marketSnapshotFixture())
  broker.tastyRequest.mockResolvedValue(optionChain(chainRow()))
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
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const brief = await generateDailyResearch({
      AI: { ...unsupportedAi(), run },
      REDDIT_CLIENT_ID: secret,
      REDDIT_CLIENT_SECRET: secret,
    }, new Date('2026-08-14T13:30:00.000Z'))
    const logged: unknown[] = info.mock.calls.map((call) => JSON.parse(String(call[0])))
    info.mockRestore()

    expect(logged).toContainEqual({
      event: 'DailyResearchMoversBound', bound: 1, candidates: 1, detected: 1, runId: expect.any(String),
    })
    expect(logged).toContainEqual({
      event: 'DailyResearchIdeasBound', bound: 1, candidates: 1, runId: expect.any(String),
    })
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

  it('numbers every packet item so the editor copies an index instead of counting positions', async () => {
    sources.collectRedditSources.mockResolvedValueOnce([{
      context: 'NVDA demand is drawing renewed attention.',
      source: 'Reddit · r/wallstreetbets', symbols: ['NVDA'], title: 'NVDA demand discussion',
      url: 'https://www.reddit.com/r/wallstreetbets/comments/abc123/nvda_discussion/',
    }, {
      context: 'A second NVDA thread repeats the same demand chatter.',
      source: 'Reddit · r/options', symbols: ['NVDA'], title: 'NVDA options flow',
      url: 'https://www.reddit.com/r/options/comments/def456/nvda_flow/',
    }])
    sources.collectOfficialSources.mockResolvedValueOnce([{
      context: 'NVIDIA published an update.', source: 'Official source', symbols: ['NVDA'],
      title: 'NVIDIA update', url: 'https://example.com/nvda',
    }, {
      context: 'A regulator published a second notice.', source: 'Official source',
      title: 'Regulatory notice', url: 'https://example.com/notice',
    }])
    collectMarketMovers.mockResolvedValueOnce([{
      context: 'PLTR is up 8.41%.',
      marketMover: {
        category: 'gainer', changePercent: 8.41, name: 'Palantir Technologies',
        price: 184.27, symbol: 'PLTR', volume: 79_200_000,
      },
      source: 'Yahoo Finance market movers', title: 'PLTR +8.41%',
      url: 'https://finance.yahoo.com/quote/PLTR',
    }])
    const coverageRow = (day: string, headline: string) => ({
      description: 'A prior brief covered this ticker.', direction: 'bullish', headline,
      horizon: null, published_at: `2026-08-${day}T13:30:00.000Z`, risk: 'The setup invalidates.',
      setup: null, symbol: 'NVDA', thesis: null,
    })
    const all = vi.fn().mockResolvedValue(
      d1Result([coverageRow('12', 'Earlier read'), coverageRow('13', 'Later read')]),
    )
    const coverageStatement = {
      ...unsupportedStatement(),
      bind: () => ({ ...unsupportedStatement(), all }),
    }
    const writeStatement = {
      ...unsupportedStatement(),
      bind: () => ({ ...unsupportedStatement(), run: vi.fn().mockResolvedValue(d1Result([], 1)) }),
    }
    const prepare = vi.fn((sql: string) => (sql.includes('SELECT') ? coverageStatement : writeStatement))
    const DB: D1Database = { ...unsupportedDatabase(), prepare }
    const run = vi.fn().mockImplementation(async (_model, options) => ({
      output_text: JSON.stringify(
        options.text.format.name === 'spice_reddit_catalysts' ? { catalysts: [] } : generatedResearch(),
      ),
    }))

    await generateDailyResearch({
      AI: { ...unsupportedAi(), run },
      DB,
      REDDIT_CLIENT_ID: secret,
      REDDIT_CLIENT_SECRET: secret,
    }, new Date('2026-08-14T13:30:00.000Z'))

    const packetIndices = (prompt: string, label: string, next: string): number[] => z
      .array(z.object({ index: z.number() }))
      .parse(JSON.parse(promptSection(prompt, label, next)))
      .map((item) => item.index)
    const positions = (indices: readonly number[]) => indices.map((_index, position) => position)

    const briefPrompt = promptFor(run, 'spice_daily_intelligence')
    const packetEvidence = z.array(z.object({ index: z.number(), marketMover: z.object({ symbol: z.string() }).optional() }))
      .parse(JSON.parse(briefEvidencePacketJson(briefPrompt)))
    const evidence = packetEvidence.map((item) => item.index)
    const coverage = packetIndices(briefPrompt, 'addressed by the same index field: ', '. Detected market movers')
    const redditEvidence = packetIndices(
      promptFor(run, 'spice_reddit_catalysts'),
      'cite an item by copying its own index field: ',
      '. A catalyst may be emitted',
    )

    expect(evidence.length).toBeGreaterThan(1)
    expect(evidence).toEqual(positions(evidence))
    expect(coverage.length).toBeGreaterThan(1)
    expect(coverage).toEqual(positions(coverage))
    expect(redditEvidence.length).toBeGreaterThan(1)
    expect(redditEvidence).toEqual(positions(redditEvidence))

    const detectedMovers = z.array(z.object({ evidenceIndices: z.array(z.number()), symbol: z.string() }))
      .parse(JSON.parse(promptSection(briefPrompt, 'you may cite for that move: ', '. Return title')))
    expect(detectedMovers).toEqual([{ evidenceIndices: [2], symbol: 'PLTR' }])
    expect(packetEvidence[2]?.marketMover?.symbol).toBe('PLTR')
  })

  it('feeds fresh local Codex catalysts to the editor and lets stale rows decay', async () => {
    const codexRow = (symbol: string, date: string, updatedAt: string): Catalyst => ({
      id: `codex-web:${symbol}:conference:${date}:abc`, symbol, kind: 'conference',
      title: `${symbol} investor day`, description: 'Dated by the company.', date, timing: 'unknown',
      confidence: 'estimated', source: 'Codex web · example.com',
      sourceUrl: `https://example.com/${symbol.toLowerCase()}`, updatedAt,
    })
    const snapshot = marketSnapshotFixture()
    snapshot.catalysts.push(
      codexRow('NVDA', '2026-09-10', '2026-08-14T12:30:00.000Z'),
      codexRow('META', '2026-09-12', '2026-08-01T12:00:00.000Z'),
    )
    broker.loadMarketSnapshot.mockResolvedValueOnce(snapshot)

    const { briefPrompt, logged } = await runDailyBrief()

    const evidence = z.array(z.object({ source: z.string(), symbols: z.array(z.string()).optional(), url: z.string() }))
      .parse(JSON.parse(briefEvidencePacketJson(briefPrompt)))
    expect(evidence.filter((item) => item.source.startsWith('Codex web')))
      .toEqual([{ source: 'Codex web · example.com', symbols: ['NVDA'], url: 'https://example.com/nvda' }])
    expect(logged).toContainEqual(expect.objectContaining({ event: 'DailyResearchModelCompleted', codexWebCatalysts: 1 }))
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

    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const brief = await generateDailyResearch({
      AI: { ...unsupportedAi(), run },
      REDDIT_CLIENT_ID: secret,
      REDDIT_CLIENT_SECRET: secret,
    }, new Date('2026-08-14T13:30:00.000Z'))
    const logged: unknown[] = info.mock.calls.map((call) => JSON.parse(String(call[0])))
    info.mockRestore()

    expect(brief.ideas).toEqual([])
    expect(logged).toContainEqual({
      event: 'DailyResearchIdeasBound', bound: 0, candidates: 1, runId: expect.any(String),
    })
  })

  it('publishes a play only after the current chain lists that exact contract', async () => {
    nvdaEvidence()

    const { brief, logged } = await runDailyBrief()

    expect(broker.tastyRequest).toHaveBeenCalledWith(expect.anything(), '/option-chains/NVDA')
    expect(brief.ideas[0]?.play).toBe('NVDA 225c 10/16')
    expect(logged).toContainEqual({
      event: 'DailyResearchPlaysChecked', chainUnavailable: 0, checked: 1, dropped: 0, runId: expect.any(String),
    })
  })

  it('drops an idea whose strike or expiration the current chain does not list', async () => {
    nvdaEvidence()
    broker.tastyRequest.mockResolvedValueOnce(optionChain(chainRow({ 'strike-price': '230' })))

    const missingStrike = await runDailyBrief()

    expect(missingStrike.brief.ideas).toEqual([])
    expect(missingStrike.logged).toContainEqual({
      event: 'DailyResearchPlaysChecked', chainUnavailable: 0, checked: 1, dropped: 1, runId: expect.any(String),
    })
    expect(missingStrike.logged).toContainEqual({
      event: 'DailyResearchIdeasBound', bound: 0, candidates: 1, runId: expect.any(String),
    })

    nvdaEvidence()
    broker.tastyRequest.mockResolvedValueOnce(optionChain(chainRow({ 'expiration-date': '2026-10-23' })))

    const missingExpiration = await runDailyBrief()

    expect(missingExpiration.brief.ideas).toEqual([])
    nvdaEvidence()
    broker.tastyRequest.mockResolvedValueOnce(optionChain(chainRow({ 'option-type': 'P' })))

    await expect(runDailyBrief().then((result) => result.brief.ideas)).resolves.toEqual([])
  })

  it('drops the idea when the option chain cannot be read', async () => {
    nvdaEvidence()
    broker.tastyRequest.mockRejectedValueOnce(new Error('TastytradeUnavailable'))

    const { brief, logged } = await runDailyBrief()

    expect(brief.ideas).toEqual([])
    expect(brief.summary).toBe('No evidence-linked options thesis was strong enough to surface today.')
    expect(logged).toContainEqual({
      event: 'DailyResearchPlaysChecked', chainUnavailable: 1, checked: 1, dropped: 1, runId: expect.any(String),
    })
  })

  it('reads the exact contract an editor play names', () => {
    expect(researchPlayTuple('NVDA 225c 10/16', '2026-08-14')).toEqual({
      expiry: '2026-10-16', optionType: 'C', strike: 225, underlying: 'NVDA',
    })
    expect(researchPlayTuple('SPY 725.5p 1/15', '2026-12-01')).toEqual({
      expiry: '2027-01-15', optionType: 'P', strike: 725.5, underlying: 'SPY',
    })
    expect(researchPlayTuple('NVDA 225x 10/16', '2026-08-14')).toBeUndefined()
    expect(researchPlayTuple('NVDA 225c 2/30', '2026-08-14')).toBeUndefined()
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
      symbol: 'PLTR', headline: UNCONFIRMED_MOVER_HEADLINE,
    }))
    expect(result).toContainEqual(expect.objectContaining({
      symbol: 'INTC', headline: UNCONFIRMED_MOVER_HEADLINE,
    }))
    expect(UNCONFIRMED_MOVER_HEADLINE).toBe('Move detected; driver not established')
  })

  it('binds every detected mover when the editor answers the packet row by row', () => {
    const moverEvidence = (
      symbol: string, changePercent: number, headlines: readonly string[],
    ): ResearchSourceItem[] => headlines.map((headline) => ({
      context: `${symbol} moved ${changePercent}%.`,
      marketMover: {
        category: changePercent >= 0 ? 'gainer' : 'loser',
        changePercent, name: `${symbol} Inc`, price: 100, symbol, volume: 5_000_000,
      },
      outbound: { label: `Reuters · ${headline}`, url: `https://www.reuters.com/${symbol.toLowerCase()}-${headline.length}` },
      source: 'Yahoo Finance market movers', symbols: [symbol],
      title: `${symbol} · ${headline}`, url: `https://finance.yahoo.com/quote/${symbol}`,
    }))
    const evidence: ResearchSourceItem[] = [
      { source: 'Official source', title: 'Macro note', url: 'https://example.com/macro' },
      ...moverEvidence('OKTA', 28.6, ['Okta beats and raises', 'Okta guidance lifts peers']),
      ...moverEvidence('CRWD', 9.4, ['CrowdStrike tops estimates']),
      ...moverEvidence('HQY', -7.2, ['HealthEquity cuts outlook']),
    ]

    const packet = marketMoverPacket(evidence)

    expect(packet.map((row) => [row.symbol, row.evidenceIndices])).toEqual([
      ['OKTA', [1, 2]], ['CRWD', [3]], ['HQY', [4]],
    ])
    expect(packet[0]?.headlines).toEqual(['Reuters · Okta beats and raises', 'Reuters · Okta guidance lifts peers'])
    expect(packet[0]?.changePercent).toBe(28.6)

    const answer = packet.map((row) => ({
      description: `${row.name} moved after its report. The cited coverage is a possible driver.`,
      headline: 'Earnings report is the likely driver',
      sourceIndices: row.evidenceIndices,
      symbol: row.symbol,
    }))
    const bound = marketMoverInsightsFromCandidates(answer, evidence)

    expect(bound.map((mover) => mover.symbol)).toEqual(['OKTA', 'CRWD', 'HQY'])
    expect(bound.some((mover) => mover.headline === UNCONFIRMED_MOVER_HEADLINE)).toBe(false)
    expect(bound[0]?.sources).toEqual([
      { label: 'Reuters · Okta beats and raises', url: evidence[1]!.outbound!.url },
      { label: 'Reuters · Okta guidance lifts peers', url: evidence[2]!.outbound!.url },
    ])

    const crossed = marketMoverInsightsFromCandidates(
      [{ ...answer[0]!, sourceIndices: packet[1]!.evidenceIndices }],
      evidence,
    )
    expect(crossed.find((mover) => mover.symbol === 'OKTA')?.headline).toBe(UNCONFIRMED_MOVER_HEADLINE)
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

    expect(acceptedPlays('2026-08-14', 'NVDA 225c 9/20', 'NVDA 225c 9/19', 'NVDA 225c 9/17')).toEqual([])
    expect(acceptedPlays('2026-08-14', 'NVDA 225c 9/18', 'NVDA 225c 10/16'))
      .toEqual(['NVDA 225c 9/18', 'NVDA 225c 10/16'])
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

  it('rejects every discovery venue, named or generic, without catching ordinary prose', () => {
    for (const leak of [
      'Reddit attention supports the setup.',
      'A subreddit thread flagged the print.',
      'Chatter in r/wallstreetbets preceded the move.',
      'The r/options crowd is positioned long.',
      'Twitter sentiment turned sharply positive.',
      'A viral tweet about the recall spread quickly.',
      'Traders retweeted the filing all morning.',
      'Posts on X.com pointed at the guidance cut.',
      'Retail piled in after the print circulated on X.',
      'X users flagged the unusual call volume.',
      'Social media enthusiasm outran the fundamentals.',
      'The message boards lit up after hours.',
      'A discussion board thread named the supplier.',
      'The forum crowd is already long calls.',
    ]) expect(mentionsDiscoverySource(leak), leak).toBe(true)

    for (const clean of [
      'Participation is broadening. Cheap index premium keeps convexity accessible.',
      'Management guided above consensus at the analyst day.',
      'The World Economic Forum panel raised tariff risk.',
      'The board approved a new buyback authorization.',
      'Media coverage of the merger has been broadly neutral.',
      'Xilinx-era design wins still anchor the segment.',
      'Extended-hours volume confirmed the gap.',
      'Open interest at the 225 strike doubled into the print.',
      'The company hosts an investor day on September 18.',
      'A sweet spot in the term structure favors October expiries.',
    ]) expect(mentionsDiscoverySource(clean), clean).toBe(false)
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

  it('names the editor response when its JSON is malformed or truncated', () => {
    const truncated = JSON.stringify(generatedResearch()).slice(0, 120)

    expect(() => parseGeneratedResearch({ output_text: truncated }))
      .toThrow(/^DailyResearchEditorResponse:invalid-json:/)
    expect(() => parseGeneratedResearch({}))
      .toThrow('DailyResearchEditorResponse:invalid-json:0-chars')
    expect(() => parseGeneratedRedditCatalysts({ output_text: '{"catalysts":[' }))
      .toThrow(/^DailyResearchCatalystModelResponse:invalid-json:/)
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
