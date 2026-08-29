import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type InstrumentCatalogRecord } from '../src/server/instrument-catalog'
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

function catalogItem(): InstrumentCatalogRecord {
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
    codexVersion: 'codex-cli 0.150.1',
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
    model: 'gpt-5.6-sol',
    openPageTranscripts: [`${JSON.stringify({
      type: 'item.completed',
      item: {
        type: 'web_search',
        action: { type: 'open_page', url: 'https://www.spacex.com/investors/event#agenda' },
      },
    })}\n`],
    reasoningEffort: 'xhigh',
    researchedSymbols: ['SPCX'],
    runId: 'd239f195-630c-476f-9bf3-4930be438748',
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

  it('preserves exact model text after enforcing instrument, date, and provenance boundaries', async () => {
    const env = await initializedEnv()
    const instruments = await readCatalystBootstrapInstruments(env)
    const value = artifact()
    const result = validateCatalystBootstrapArtifact(value, instruments, new Date('2026-08-26T12:00:00.000Z'))

    expect(result.catalysts).toEqual([expect.objectContaining({
      confidence: 'estimated',
      description: 'SpaceX will hold a shareholder event — the agenda includes a launch-program update.',
      sourceUrl: 'https://www.spacex.com/investors/event',
      symbol: 'SPCX',
    })])
  })

  it.each([
    ['wrong-name', { instrumentName: 'The SPAC and New Issue ETF' }],
    ['social-source', { sourceUrl: 'https://x.com/spacex/status/1234' }],
    ['out-of-range-date', { date: '2027-03-01' }],
    ['unopened-source', { sourceUrl: 'https://www.spacex.com/investors/unopened' }],
  ])('fails the whole artifact for an invalid %s finding', async (_name, replacement) => {
    const env = await initializedEnv()
    const instruments = await readCatalystBootstrapInstruments(env)
    const value = artifact()
    value.findings.push({ ...value.findings[0]!, ...replacement })

    expect(() => validateCatalystBootstrapArtifact(
      value,
      instruments,
      new Date('2026-08-26T12:00:00.000Z'),
    )).toThrow('CatalystBootstrap:invalid-finding:1:')
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
      model: 'gpt-5.6-sol/xhigh (codex-cli 0.150.1)',
      rejected_count: 0,
      status: 'completed',
      symbol_count: 1,
    })
  })

  it('does not treat a URL-shaped search query or ambiguous legacy action as a page open', async () => {
    const env = await initializedEnv()
    const instruments = await readCatalystBootstrapInstruments(env)
    const value = artifact()
    value.openPageTranscripts = [
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
