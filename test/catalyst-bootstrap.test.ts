import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type InstrumentCatalogRecord } from '../src/server/instrument-catalog'
import { type JsonValue } from '../src/domain/json-payload'
import {
  applyCatalystBootstrapArtifact,
  readCatalystBootstrapInstruments,
  validateCatalystBootstrapArtifact,
} from '../src/server/catalyst-bootstrap'
import { persistInstrumentCatalog } from '../src/server/instrument-catalog'
import { canonicalCodexSourceUrl } from '../src/server/codex-source-url'
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
      verification: {
        contentSha256: 'a'.repeat(64),
        fetchedAt: '2026-08-26T11:59:00.000Z',
        finalUrl: 'https://www.spacex.com/investors/event',
        httpStatus: 200,
        snippet: 'Shareholder event scheduled for September 24, 2026 at the Hawthorne campus.',
        via: 'fetch',
      },
    }],
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    rejectedCount: 0,
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
    // The page that answered has to be one this boundary would accept on its own terms.
    ['insecure-final-url', { verification: { contentSha256: 'a'.repeat(64), fetchedAt: '2026-08-26T11:59:00.000Z', finalUrl: 'http://www.spacex.com/investors/event', httpStatus: 200, snippet: 'Shareholder event scheduled for September 24, 2026.', via: 'fetch' } }],
  ])('drops an invalid %s finding and counts it, keeping its siblings', async (_name, replacement) => {
    const env = await initializedEnv()
    const instruments = await readCatalystBootstrapInstruments(env)
    const value = artifact()
    value.findings.push({ ...value.findings[0]!, ...replacement })

    const result = validateCatalystBootstrapArtifact(value, instruments, new Date('2026-08-26T12:00:00.000Z'))

    expect(result.catalysts).toHaveLength(1)
    expect(result.rejections).toEqual([expect.stringMatching(/^SPCX: /)])
    expect(result.rejectedCount).toBe(1)
  })

  it.each([
    ['an unreadable finding', (value: ReturnType<typeof artifact>) => {
      // SAFETY: the point of the case is a finding that violates its own schema, which the
      // fixture's type cannot express; the boundary is what has to notice, not the compiler.
      value.findings.push({ ...value.findings[0]!, date: 42 } as never)
    }],
    ['a researched symbol the watchlist does not hold', (value: ReturnType<typeof artifact>) => {
      value.researchedSymbols.push('ZZZZ')
    }],
  ])('still refuses the whole artifact for %s', async (_name, corrupt) => {
    const env = await initializedEnv()
    const instruments = await readCatalystBootstrapInstruments(env)
    const value = artifact()
    corrupt(value)

    // The producer itself is wrong here, so nothing it sent can be trusted.
    expect(() => validateCatalystBootstrapArtifact(
      value,
      instruments,
      new Date('2026-08-26T12:00:00.000Z'),
    )).toThrow('CatalystBootstrap:')
  })

  it('applies the exact validated artifact and records a compact run receipt', async () => {
    const env = await initializedEnv()
    const result = await applyCatalystBootstrapArtifact(env, artifact(), new Date('2026-08-26T12:00:00.000Z'))

    expect(result.catalysts).toHaveLength(1)
    expect(store.sqlite.prepare("SELECT symbol, source_label FROM catalysts WHERE source_provider = 'codex-web'").all()).toEqual([{
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

  it('records a failure receipt when the evidence gate refuses the artifact', async () => {
    const env = await initializedEnv()
    const value = artifact()
    // A contract violation rather than one weak citation, so the whole artifact is refused
    // and that refusal still has to leave a receipt behind.
    value.researchedSymbols.push('ZZZZ')

    await expect(applyCatalystBootstrapArtifact(env, value, new Date('2026-08-26T12:00:00.000Z')))
      .rejects.toThrow('CatalystBootstrap:unknown-researched-symbol')

    expect(store.sqlite.prepare("SELECT COUNT(*) AS rows FROM catalysts WHERE source_provider = 'codex-web'").get())
      .toEqual({ rows: 0 })
    expect(store.sqlite.prepare(
      'SELECT model, status, symbol_count, error_code FROM catalyst_research_runs',
    ).get()).toEqual({
      error_code: 'CatalystBootstrap:unknown-researched-symbol',
      model: 'gpt-5.6-sol/xhigh (codex-cli 0.150.1)',
      status: 'failed',
      symbol_count: 2,
    })
  })

  it('records what the runner refused so a run that verifies little is visible', async () => {
    const env = await initializedEnv()
    const value = artifact()
    value.rejectedCount = 7

    await applyCatalystBootstrapArtifact(env, value, new Date('2026-08-26T12:00:00.000Z'))

    expect(store.sqlite.prepare(
      'SELECT accepted_count, rejected_count, status FROM catalyst_research_runs',
    ).get()).toEqual({ accepted_count: 1, rejected_count: 7, status: 'completed' })
  })

  it('refuses a finding whose fetched page never states the date', async () => {
    const env = await initializedEnv()
    const instruments = await readCatalystBootstrapInstruments(env)
    const value = artifact()
    // The page was served and read; it just does not say what the finding claims.
    value.findings[0]!.verification.snippet = 'Upcoming events will be announced in due course.'

    const result = validateCatalystBootstrapArtifact(value, instruments, new Date('2026-08-26T12:00:00.000Z'))

    expect(result.catalysts).toEqual([])
    expect(result.rejections).toEqual(['SPCX: unverified-date'])
  })

  it('reads the date the page actually rendered rather than only its ISO form', async () => {
    const env = await initializedEnv()
    const instruments = await readCatalystBootstrapInstruments(env)
    for (const rendering of ['2026-09-24', 'Sep 24, 2026', '24 September 2026', '9/24/2026']) {
      const value = artifact()
      value.findings[0]!.verification.snippet = `Event on ${rendering} at the campus.`
      expect(validateCatalystBootstrapArtifact(
        value,
        instruments,
        new Date('2026-08-26T12:00:00.000Z'),
      ).catalysts).toHaveLength(1)
    }
  })

  it('attributes the citation to the host that served the bytes, not the one cited', async () => {
    const env = await initializedEnv()
    const instruments = await readCatalystBootstrapInstruments(env)
    const value = artifact()
    // A redirect is normal for investor-relations hosts; the label must follow it so a
    // cited host can never vouch for a page served somewhere else.
    value.findings[0]!.verification.finalUrl = 'https://spacex.gcs-web.com/investors/event'

    const result = validateCatalystBootstrapArtifact(value, instruments, new Date('2026-08-26T12:00:00.000Z'))

    expect(result.catalysts[0]).toEqual(expect.objectContaining({
      source: 'Codex web · spacex.gcs-web.com',
      sourceUrl: 'https://spacex.gcs-web.com/investors/event',
    }))
  })

  it('still refuses a social citation that redirects somewhere respectable', async () => {
    const env = await initializedEnv()
    const instruments = await readCatalystBootstrapInstruments(env)
    const value = artifact()
    value.findings[0]!.sourceUrl = 'https://x.com/spacex/status/1234'

    const result = validateCatalystBootstrapArtifact(value, instruments, new Date('2026-08-26T12:00:00.000Z'))

    expect(result.catalysts).toEqual([])
    expect(result.rejections).toEqual(['SPCX: invalid-provenance'])
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
