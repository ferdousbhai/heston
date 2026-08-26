import { readFile } from 'node:fs/promises'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { type InstrumentCatalogItem } from '../src/domain/instrument'
import {
  applyCatalystBootstrapArtifact,
  readCatalystBootstrapInstruments,
  validateCatalystBootstrapArtifact,
} from '../src/server/catalyst-bootstrap'
import { persistInstrumentCatalog } from '../src/server/instrument-catalog'
import { ensureInternalWatchlistSeeded } from '../src/server/internal-watchlist'
import { sqliteD1 } from './sqlite-d1'

let migrations: string[]
let store: ReturnType<typeof sqliteD1>

beforeAll(async () => {
  migrations = await Promise.all(Array.from({ length: 10 }, (_, index) => (
    readFile(new URL(`../migrations/${String(index + 1).padStart(4, '0')}_${[
      'spice', 'scheduled_runs', 'public_market_universe', 'catalyst_description',
      'brokerage_action_state', 'internal_watchlist', 'internal_watchlist_validation',
      'instrument_catalog', 'instrument_catalog_resolution',
      'source_specific_market_data',
    ][index]}.sql`, import.meta.url), 'utf8')
  )))
})

beforeEach(() => {
  store = sqliteD1(migrations)
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
  return env
}

function artifact() {
  return {
    findings: [{
      date: '2026-09-24',
      description: 'SpaceX will hold a shareholder event — the agenda includes a launch-program update.',
      instrumentName: 'SpaceX Corporation',
      kind: 'shareholder',
      sourceName: 'SpaceX investor relations',
      sourceType: 'first-party',
      sourceUrl: 'https://www.spacex.com/investors/event#agenda',
      symbol: 'SPCX',
      timing: 'unknown',
      title: 'SpaceX shareholder event',
    }],
    generatedAt: '2026-08-26T12:00:00.000Z',
    researchedSymbols: ['SPCX'],
    runId: 'd239f195-630c-476f-9bf3-4930be438748',
  }
}

describe('local Codex catalyst bootstrap boundary', () => {
  it('uses exact stored instrument identity and rejects social, wrong-name, and out-of-range evidence', async () => {
    const env = await initializedEnv()
    const instruments = await readCatalystBootstrapInstruments(env)
    const value = artifact()
    value.findings.push(
      { ...value.findings[0]!, instrumentName: 'The SPAC and New Issue ETF' },
      { ...value.findings[0]!, sourceUrl: 'https://x.com/spacex/status/1234' },
      { ...value.findings[0]!, date: '2027-03-01' },
    )

    const result = validateCatalystBootstrapArtifact(value, instruments, new Date('2026-08-26T12:00:00.000Z'))

    expect(result.catalysts).toEqual([expect.objectContaining({
      confidence: 'confirmed',
      description: 'SpaceX will hold a shareholder event - the agenda includes a launch-program update.',
      sourceUrl: 'https://www.spacex.com/investors/event',
      symbol: 'SPCX',
    })])
    expect(result.rejected).toHaveLength(3)
  })

  it('applies the exact validated artifact and records a compact run receipt', async () => {
    const env = await initializedEnv()
    const result = await applyCatalystBootstrapArtifact(env, artifact(), new Date('2026-08-26T12:00:00.000Z'))

    expect(result.catalysts).toHaveLength(1)
    expect(store.sqlite.prepare('SELECT symbol, source_label FROM codex_web_catalysts').all()).toEqual([{
      source_label: 'Codex web · SpaceX investor relations', symbol: 'SPCX',
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
})
