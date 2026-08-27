import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type InstrumentCatalogItem } from '../src/domain/instrument'
import { type JsonValue } from '../src/domain/json-payload'
import {
  applyCatalystBootstrapArtifact,
  readCatalystBootstrapInstruments,
  validateCatalystBootstrapArtifact,
} from '../src/server/catalyst-bootstrap'
import { persistInstrumentCatalog } from '../src/server/instrument-catalog'
import { canonicalCodexSourceUrl } from '../src/server/codex-transcript-evidence'
import { ensureInternalWatchlistSeeded, finalizeInternalWatchlist } from '../src/server/internal-watchlist'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => store.close())

function catalogItem(): InstrumentCatalogItem {
  return {
    active: true,
    borrowRate: 0.02,
    bypassManualReview: false,
    countryOfIncorporation: 'United States',
    countryOfTaxation: 'United States',
    createdAt: '2026-08-26T12:00:00.000Z',
    description: 'SpaceX Corporation',
    haltedAt: null,
    identityRefreshedAt: '2026-08-26T12:00:00.000Z',
    identitySource: 'equity-endpoint',
    instrumentSubType: 'Common Stock',
    instrumentType: 'Equity',
    isClosingOnly: false,
    isEtf: false,
    isFractionalQuantityEligible: true,
    isIlliquid: false,
    isIndex: false,
    isOptionsClosingOnly: false,
    lendability: 'Easy To Borrow',
    listedMarket: 'NASDAQ',
    marketTimeInstrumentCollection: 'Equity',
    overnightTradingPermitted: true,
    preIpo: false,
    resolutionStatus: 'resolved',
    shortDescription: 'SpaceX',
    source: 'tastytrade',
    statusRefreshedAt: '2026-08-26T12:00:00.000Z',
    stopsTradingAt: null,
    streamerSymbol: 'SPCX',
    symbol: 'SPCX',
    tickSizes: [],
    underlyingProductType: 'Equity',
    updatedAt: '2026-08-26T12:00:00.000Z',
  }
}

async function initializedEnv() {
  const env = { DB: store.database }
  await ensureInternalWatchlistSeeded(env, async () => ({
    privatePayload: [{
      name: 'Private',
      'watchlist-entries': [{ symbol: 'SPCX', 'instrument-type': 'Equity' }],
    }],
    publicPayload: [],
  }), new Date('2026-08-26T12:00:00.000Z'))
  await persistInstrumentCatalog(env, [catalogItem()])
  await finalizeInternalWatchlist(env, [], new Date('2026-08-26T12:01:00.000Z'))
  return env
}

function artifact() {
  return {
    findings: [{
      date: '2026-09-24',
      description: 'SpaceX will hold a shareholder event — the agenda includes a launch-program update.',
      instrumentName: 'SpaceX Corporation',
      kind: 'shareholder',
      sourceUrl: 'https://www.spacex.com/investors/event#agenda',
      symbol: 'SPCX',
      timing: 'unknown',
      title: 'SpaceX shareholder event',
    }],
    generatedAt: '2026-08-26T12:00:00.000Z',
    researchedSymbols: ['SPCX'],
    runId: 'd239f195-630c-476f-9bf3-4930be438748',
    transcripts: [`${JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'web_search',
        action: { type: 'open_page', url: 'https://www.spacex.com/investors/event#agenda' },
      },
    })}\n`],
  }
}

describe('local Codex catalyst bootstrap boundary', () => {
  it('rejects Reddit, X, Twitter, and their short-link domains as manual evidence', () => {
    expect(canonicalCodexSourceUrl('https://new.reddit.com/r/test/comments/1')).toBeUndefined()
    expect(canonicalCodexSourceUrl('https://redd.it/example')).toBeUndefined()
    expect(canonicalCodexSourceUrl('https://mobile.twitter.com/example/status/1')).toBeUndefined()
    expect(canonicalCodexSourceUrl('https://api.x.com/example/status/1')).toBeUndefined()
    expect(canonicalCodexSourceUrl('https://t.co/example')).toBeUndefined()
    expect(canonicalCodexSourceUrl('https://reddit.com./r/test/comments/1')).toBeUndefined()
    expect(canonicalCodexSourceUrl('https://redd.it./example')).toBeUndefined()
    expect(canonicalCodexSourceUrl('https://x.com./example/status/1')).toBeUndefined()
    expect(canonicalCodexSourceUrl('https://t.co./example')).toBeUndefined()
  })

  it('uses exact stored instrument identity and rejects social, wrong-name, and out-of-range evidence', async () => {
    const env = await initializedEnv()
    const instruments = await readCatalystBootstrapInstruments(env)
    const value = artifact()
    value.findings.push(
      { ...value.findings[0]!, instrumentName: 'The SPAC and New Issue ETF' },
      { ...value.findings[0]!, sourceUrl: 'https://x.com/spacex/status/1234' },
      { ...value.findings[0]!, date: '2027-03-01' },
      { ...value.findings[0]!, sourceUrl: 'https://www.spacex.com/investors/unopened' },
    )

    const result = validateCatalystBootstrapArtifact(value, instruments, new Date('2026-08-26T12:00:00.000Z'))

    expect(result.catalysts).toEqual([expect.objectContaining({
      confidence: 'estimated',
      description: 'SpaceX will hold a shareholder event - the agenda includes a launch-program update.',
      sourceUrl: 'https://www.spacex.com/investors/event',
      symbol: 'SPCX',
    })])
    expect(result.rejected).toHaveLength(4)
  })

  it('applies the exact validated artifact and records a compact run receipt', async () => {
    const env = await initializedEnv()
    const result = await applyCatalystBootstrapArtifact(env, artifact(), new Date('2026-08-26T12:00:00.000Z'))

    expect(result.catalysts).toHaveLength(1)
    expect(store.sqlite.prepare('SELECT symbol, source_label FROM codex_web_catalysts').all()).toEqual([{
      source_label: 'Codex web · spacex.com', symbol: 'SPCX',
    }])
    expect(store.sqlite.prepare(
      'SELECT model, status, symbol_count, accepted_count, rejected_count FROM catalyst_research_runs',
    ).get()).toEqual({
      accepted_count: 1,
      model: 'local-codex-native-web',
      rejected_count: 0,
      status: 'completed',
      symbol_count: 1,
    })
  })

  it('does not treat a URL-shaped search query or ambiguous legacy action as a page open', async () => {
    const env = await initializedEnv()
    const instruments = await readCatalystBootstrapInstruments(env)
    const value = artifact()
    value.transcripts = [
      `${JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'web_search',
          query: 'https://www.spacex.com/investors/event',
          action: { type: 'search', queries: ['https://www.spacex.com/investors/event'] },
        },
      })}\n${JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'web_search',
          query: 'https://www.spacex.com/investors/event',
          action: { type: 'other' },
        },
      })}\n`,
    ]

    expect(() => validateCatalystBootstrapArtifact(
      value,
      instruments,
      new Date('2026-08-26T12:00:00.000Z'),
    )).toThrow('codex-open-page-evidence-unavailable')
  })

  it('rejects a supplied artifact that asserts URLs without raw transcript evidence', async () => {
    const env = await initializedEnv()
    const instruments = await readCatalystBootstrapInstruments(env)
    const complete = artifact()
    const value: JsonValue = {
      accessedUrls: ['https://www.spacex.com/investors/event'],
      findings: complete.findings,
      generatedAt: complete.generatedAt,
      researchedSymbols: complete.researchedSymbols,
      runId: complete.runId,
    }

    expect(() => validateCatalystBootstrapArtifact(
      value,
      instruments,
      new Date('2026-08-26T12:00:00.000Z'),
    )).toThrow()
  })
})
