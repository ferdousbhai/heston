import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type Catalyst } from '../src/domain/catalyst'
import { JsonObjectSchema } from '../src/domain/json-payload'
import { generateDailyResearch, shouldRunDailyResearch } from '../src/server/research'
import {
  resetDailyResearchAgent,
  setDailyResearchAgent,
  type DailyResearchAgent,
  type DailyResearchAgentRequest,
  type DailyResearchSubmission,
} from '../src/server/research-agent'
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
  readingListFromCandidates,
  redditCatalystsFromCandidates,
  researchIdeasForDate,
  UNCONFIRMED_MOVER_HEADLINE,
} from '../src/server/research-output'
import {
  resetResearchSources,
  setResearchSources,
  type ResearchSources,
} from '../src/server/research-sources'
import {
  resetInternalWatchlistWriter,
  setInternalWatchlistWriter,
  type InternalWatchlistWriter,
} from '../src/server/internal-watchlist'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { unsupportedAi } from './fake-ai'
import { marketSnapshotFixture } from './fixtures/market'

const sources = {
  collectOfficialSources: vi.fn<ResearchSources['collectOfficialSources']>(async () => []),
  collectRedditSources: vi.fn<ResearchSources['collectRedditSources']>(async () => []),
} satisfies ResearchSources
const collectMarketMovers = vi.fn<MarketMoverResearch['collect']>(async () => [])
const marketMovers = { collect: collectMarketMovers } satisfies MarketMoverResearch
const runResearchAgent = vi.fn<DailyResearchAgent['run']>()
const researchAgent = { run: runResearchAgent } satisfies DailyResearchAgent
const broker = stubBroker()
const secret: SecretsStoreSecret = { get: async () => 'secret' }
const internalWatchlist = { ensureSymbols: vi.fn() } satisfies InternalWatchlistWriter

type GeneratedResearch = Pick<DailyResearchSubmission,
  'ideas' | 'marketMovers' | 'readingList' | 'regime' | 'regimeDetail' | 'summary' | 'title'>

function proposedPlay(expiration: string, strike = 225, optionType: 'call' | 'put' = 'call') {
  return { expiration, optionType, strike }
}

function publicIdeasForDate(...args: Parameters<typeof researchIdeasForDate>) {
  return researchIdeasForDate(...args).map((candidate) => candidate.idea)
}

function generatedResearch(): GeneratedResearch {
  return {
    title: 'Daily brief',
    summary: 'Summary',
    regime: 'Selective',
    regimeDetail: 'Defined risk',
    ideas: [{
      symbol: 'NVDA',
      direction: 'bullish',
      headline: 'Breadth keeps improving',
      description: 'Participation is broadening. Cheap index premium keeps convexity accessible.',
      play: proposedPlay('2026-10-16'),
      risk: 'Breadth reverses while the index stalls.',
      sourceIndices: [0],
      thesisChange: '',
    }],
    marketMovers: [],
    readingList: [],
  }
}

function submissionFor(
  request: DailyResearchAgentRequest,
  output = generatedResearch(),
): DailyResearchSubmission {
  const reportSources = request.evidence.flatMap((item, evidenceIndex) => {
    const symbol = item.symbols?.[0]
    if (!symbol) return []
    return [{
      evidenceIndex,
      symbol,
    }]
  })
  const sourceIndex = (symbol: string) => Math.max(
    0,
    reportSources.findIndex((source) => source.symbol === symbol),
  )
  return {
    ...output,
    sources: reportSources,
    ideas: output.ideas.map((idea) => ({ ...idea, sourceIndices: [sourceIndex(idea.symbol)] })),
    marketMovers: output.marketMovers.map((mover) => ({
      ...mover,
      sourceIndices: [sourceIndex(mover.symbol)],
    })),
    redditCatalysts: [],
    xCatalysts: [],
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
    context: 'Post: NVDA demand is drawing renewed attention.\nTop comments: • Supply is the key debate.',
    linkedPages: [{
      excerpt: 'Reuters reports a new NVIDIA supply agreement.',
      label: 'reuters.com',
      title: 'NVIDIA supply agreement',
      url: 'https://www.reuters.com/technology/nvidia-supply',
    }],
    source: 'Reddit · r/wallstreetbets',
    symbols: ['NVDA'],
    title: 'NVDA demand discussion',
    url: 'https://www.reddit.com/r/wallstreetbets/comments/abc123/nvda_discussion/',
  }])
}

async function runDailyBrief() {
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  try {
    const brief = await generateDailyResearch({
      AI: unsupportedAi(),
      REDDIT_CLIENT_ID: secret,
      REDDIT_CLIENT_SECRET: secret,
    }, new Date('2026-08-14T13:30:00.000Z'))
    return {
      brief,
      logged: info.mock.calls.map((call) => JsonObjectSchema.parse(JSON.parse(String(call[0])))),
      request: runResearchAgent.mock.calls.at(-1)?.[1],
    }
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
  setMarketMoverResearch(marketMovers)
  runResearchAgent.mockImplementation(async (_env, request) => ({
    citations: new Set(),
    submission: submissionFor(request),
    webSearches: 1,
    xSearches: 1,
  }))
  setDailyResearchAgent(researchAgent)
  internalWatchlist.ensureSymbols.mockReset().mockImplementation(async (_env, symbols) => [...symbols])
  setInternalWatchlistWriter(internalWatchlist)
})

afterEach(() => {
  resetBrokerApi()
  resetResearchSources()
  resetDailyResearchAgent()
  resetMarketMoverResearch()
  resetInternalWatchlistWriter()
})

describe('daily research schedule', () => {
  it('runs in the three weekday New York claim windows', () => {
    expect(shouldRunDailyResearch(new Date('2026-08-13T13:30:00.000Z'))).toBe(true)
    expect(shouldRunDailyResearch(new Date('2026-08-13T13:40:00.000Z'))).toBe(true)
    expect(shouldRunDailyResearch(new Date('2026-08-13T13:50:00.000Z'))).toBe(true)
    expect(shouldRunDailyResearch(new Date('2026-12-14T14:30:00.000Z'))).toBe(true)
    expect(shouldRunDailyResearch(new Date('2026-08-15T13:30:00.000Z'))).toBe(false)
  })
})

describe('daily intelligence pipeline', () => {
  it('fails a scheduled run before discovery when the market is not open', async () => {
    const snapshot = marketSnapshotFixture()
    snapshot.marketState = 'pre'
    broker.loadMarketSnapshot.mockResolvedValueOnce(snapshot)

    await expect(generateDailyResearch({
      AI: unsupportedAi(), REDDIT_CLIENT_ID: secret, REDDIT_CLIENT_SECRET: secret,
    }, new Date('2026-08-14T13:30:00.000Z'), { requireMarketOpen: true }))
      .rejects.toThrow('DailyResearchMarketNotOpen:pre')
    expect(sources.collectRedditSources).not.toHaveBeenCalled()
    expect(runResearchAgent).not.toHaveBeenCalled()
  })

  it('prepares official, Reddit, and mover evidence before one agent run', async () => {
    let releaseReddit!: (items: ResearchSourceItem[]) => void
    let releaseMovers!: (items: ResearchSourceItem[]) => void
    sources.collectRedditSources.mockImplementationOnce(() => new Promise((resolve) => {
      releaseReddit = resolve
    }))
    collectMarketMovers.mockImplementationOnce(() => new Promise((resolve) => {
      releaseMovers = resolve
    }))

    const pending = generateDailyResearch({
      AI: unsupportedAi(), REDDIT_CLIENT_ID: secret, REDDIT_CLIENT_SECRET: secret,
    }, new Date('2026-08-14T13:30:00.000Z'))

    await vi.waitFor(() => {
      expect(sources.collectOfficialSources).toHaveBeenCalledOnce()
      expect(sources.collectRedditSources).toHaveBeenCalledOnce()
      expect(collectMarketMovers).toHaveBeenCalledOnce()
    })
    expect(runResearchAgent).not.toHaveBeenCalled()
    releaseReddit([])
    releaseMovers([])
    await expect(pending).resolves.toMatchObject({ id: 'brief-2026-08-14' })
    expect(runResearchAgent).toHaveBeenCalledOnce()
  })

  it('passes old ask-dan Reddit text, comments, and fetched links into the single agent packet', async () => {
    nvdaEvidence()
    const { brief, request } = await runDailyBrief()

    const redditPacket = JSON.stringify(request?.redditEvidence)
    expect(redditPacket).toContain('Top comments')
    expect(redditPacket).toContain('Supply is the key debate')
    expect(redditPacket).toContain('https://www.reuters.com/technology/nvidia-supply')
    expect(request?.marketMetrics.map((ticker) => ticker.symbol)).toEqual(['NVDA'])
    expect(request).not.toHaveProperty('symbols')
    expect(request).not.toHaveProperty('candidateSymbols')
    expect(runResearchAgent).toHaveBeenCalledOnce()
    expect(brief.sources.some((source) => source.url.includes('reddit.com'))).toBe(false)
  })

  it('binds a typed recommendation and verifies its exact option contract', async () => {
    nvdaEvidence()
    const { brief, logged } = await runDailyBrief()

    expect(brief.ideas).toEqual([expect.objectContaining({
      symbol: 'NVDA', direction: 'bullish', play: 'NVDA 225c 10/16',
    })])
    expect(broker.tastyRequest).toHaveBeenCalledWith(expect.anything(), '/option-chains/NVDA')
    expect(logged).toContainEqual(expect.objectContaining({
      event: 'DailyResearchPlaysChecked', checked: 1, structureCleared: 0,
    }))
  })

  it('keeps the thesis but clears a contract absent from the current chain', async () => {
    nvdaEvidence()
    broker.tastyRequest.mockResolvedValueOnce(optionChain(chainRow({ 'strike-price': '230' })))
    const { brief } = await runDailyBrief()
    expect(brief.ideas).toEqual([expect.objectContaining({ symbol: 'NVDA', play: null })])
  })

  it('accepts native-search evidence only when the provider cited its URL', async () => {
    nvdaEvidence()
    const cited = 'https://example.com/nvda-primary'
    runResearchAgent.mockImplementationOnce(async (_env, request) => {
      const submission = submissionFor(request)
      submission.sources = [{
        context: 'The company signed a new supply agreement; execution remains uncertain.',
        evidenceIndex: null,
        sourceUrl: cited,
        symbol: 'NVDA',
        title: 'NVIDIA signs supply agreement',
      }]
      submission.ideas[0]!.sourceIndices = [0]
      return { citations: new Set([cited]), submission, webSearches: 1, xSearches: 1 }
    })
    const { brief } = await runDailyBrief()
    expect(brief.ideas[0]?.sources).toEqual([{
      label: 'Grok research · example.com · NVIDIA signs supply agreement',
      url: cited,
    }])
  })

  it('drops an uncited native-search source and the idea that depends on it', async () => {
    runResearchAgent.mockImplementationOnce(async (_env, request) => {
      const submission = submissionFor(request)
      submission.sources = [{
        context: 'This source was not present in citation metadata.',
        evidenceIndex: null,
        sourceUrl: 'https://example.com/invented',
        symbol: 'NVDA',
        title: 'Invented source',
      }]
      submission.ideas[0]!.sourceIndices = [0]
      return { citations: new Set(), submission, webSearches: 1, xSearches: 1 }
    })
    const { brief } = await runDailyBrief()
    expect(brief.ideas).toEqual([])
  })

  it('feeds only fresh local Codex evidence to the agent', async () => {
    const codexRow = (symbol: string, date: string, updatedAt: string): Catalyst => ({
      id: `codex-web:${symbol}:conference:${date}:abc`,
      symbol,
      kind: 'conference',
      title: `${symbol} investor day`,
      description: 'Dated by the company.',
      date,
      timing: 'unknown',
      confidence: 'estimated',
      source: 'Codex web · example.com',
      sourceUrl: `https://example.com/${symbol.toLowerCase()}`,
      updatedAt,
    })
    const snapshot = marketSnapshotFixture()
    snapshot.catalysts.push(
      codexRow('NVDA', '2026-09-10', '2026-08-14T12:30:00.000Z'),
      codexRow('META', '2026-09-12', '2026-08-01T12:00:00.000Z'),
    )
    broker.loadMarketSnapshot.mockResolvedValueOnce(snapshot)

    const { request, logged } = await runDailyBrief()
    const evidencePacket = JSON.stringify(request?.evidence)
    expect(evidencePacket).toContain('https://example.com/nvda')
    expect(evidencePacket).not.toContain('https://example.com/meta')
    expect(logged).toContainEqual(expect.objectContaining({
      event: 'DailyResearchModelCompleted', codexWebCatalysts: 1,
    }))
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
    }] as const

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

  it('drops out-of-horizon proposed contracts before a chain lookup', () => {
    const idea = {
      ...generatedResearch().ideas[0]!,
      direction: 'bullish' as const,
    }
    const evidence = [{
      source: 'Example', symbols: ['NVDA'], title: 'NVIDIA update', url: 'https://example.com/nvda',
    }]
    const {
      play: _play,
      sourceIndices: _sourceIndices,
      thesisChange: _thesisChange,
      ...ideaWithoutIndices
    } = idea
    const accepted = {
      ...ideaWithoutIndices,
      play: 'NVDA 225c 10/16',
      sources: [{ label: 'Example · NVIDIA update', url: 'https://example.com/nvda' }],
    }
    expect(publicIdeasForDate([
      { ...idea, play: proposedPlay('2026-02-30') },
      { ...idea, play: proposedPlay('2026-08-20') },
      { ...idea, play: proposedPlay('2026-12-31') },
      idea,
    ], '2026-08-14', evidence, ['NVDA'])).toEqual([accepted])

    expect(publicIdeasForDate([{ ...idea, play: proposedPlay('2027-01-15') }], '2026-12-01', evidence, ['NVDA']))
      .toEqual([{ ...accepted, play: 'NVDA 225c 1/15' }])
    expect(publicIdeasForDate([idea], '2026-08-14', [{ ...evidence[0], symbols: ['SPCX'] }], ['NVDA']))
      .toEqual([])
  })

  it('carries the structured contract through to live chain verification', () => {
    const idea = { ...generatedResearch().ideas[0]!, direction: 'bullish' as const }
    const evidence = [{
      source: 'Example', symbols: ['NVDA'], title: 'NVIDIA update', url: 'https://example.com/nvda',
    }]
    const [bound] = researchIdeasForDate([
      { ...idea, play: proposedPlay('2026-09-20', 225, 'put') },
    ], '2026-08-14', evidence, ['NVDA'])

    expect(bound).toEqual(expect.objectContaining({
      contract: { expiry: '2026-09-20', optionType: 'P', strike: 225, underlying: 'NVDA' },
      idea: expect.objectContaining({ play: 'NVDA 225p 9/20' }),
    }))
  })

  it('requires newer evidence and an explanation when a repeated symbol changes thesis', () => {
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
      thesisChange: 'The prior thesis relied on breadth; a signed supply agreement now adds company-specific demand evidence.',
    }

    expect(publicIdeasForDate([base], '2026-08-14', evidence, ['NVDA'], recentCoverage))
      .toEqual([expect.objectContaining({ headline: base.headline })])
    expect(publicIdeasForDate([changed], '2026-08-14', [
      { ...evidence[0], publishedAt: '2026-08-11T12:00:00.000Z' },
    ], ['NVDA'], recentCoverage)).toEqual([])
    expect(publicIdeasForDate([changed], '2026-08-14', evidence, ['NVDA'], recentCoverage))
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
    expect(publicIdeasForDate([idea], '2026-08-14', evidence, ['NVDA'])).toEqual([])
  })

  it('cites the fetched article that supplied an idea instead of its aggregator page', () => {
    const idea = { ...generatedResearch().ideas[0]!, direction: 'bullish' as const }
    const evidence = [{
      source: 'Yahoo Finance market movers', symbols: ['NVDA'], title: 'NVDA +4.2% · supply update',
      url: 'https://finance.yahoo.com/quote/NVDA',
      outbound: { label: 'Reuters · NVIDIA supply update', url: 'https://www.reuters.com/technology/nvidia-supply' },
    }]

    expect(publicIdeasForDate([idea], '2026-08-14', evidence, ['NVDA'])[0]?.sources).toEqual([
      evidence[0]!.outbound,
    ])
  })

  it('binds ranked reading picks to trusted evidence URLs and ignores invented indices', () => {
    const evidence: ResearchSourceItem[] = [{
      outbound: { label: 'Reuters · NVIDIA supply update', url: 'https://www.reuters.com/nvidia-supply' },
      source: 'Ticker research', symbols: ['NVDA'], title: 'NVDA update', url: 'https://example.com/aggregate',
    }, {
      source: 'Yahoo Finance market movers', symbols: ['NVDA'], title: 'NVDA quote',
      url: 'https://finance.yahoo.com/quote/NVDA',
    }]

    expect(readingListFromCandidates([
      { sourceIndex: 0, reason: 'Reddit attention made this worth reading.' },
      { sourceIndex: 0, reason: 'Primary reporting with the concrete agreement terms.' },
      { sourceIndex: 1, reason: 'A generic quote page should not make the reading list.' },
      { sourceIndex: 99, reason: 'An invented source must not bind.' },
    ], evidence)).toEqual([{
      reason: 'Primary reporting with the concrete agreement terms.',
      title: 'Reuters · NVIDIA supply update',
      url: 'https://www.reuters.com/nvidia-supply',
    }])
  })
})
