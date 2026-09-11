import { z } from 'zod'

import {
  EquitySymbolSchema,
  InstrumentCatalogItemSchema,
  type InstrumentCatalogItem,
} from '../domain/instrument'
import {
  envelopeRows,
  jsonNumber,
  jsonObject,
  jsonText,
  type JsonValue,
} from '../domain/json-payload'
import { type AppEnv } from './env'
import { D1_MAX_BOUND_PARAMETERS, rowsPerD1Statement } from './d1-limits'

// One refresh chunk: the symbols a loader may carry in a single provider request, and
// the rows one D1 batch persists. The stored catalog is far larger than either.
const CATALOG_REFRESH_CHUNK_SIZE = 100
const SQL_SYMBOL_CHUNK_SIZE = D1_MAX_BOUND_PARAMETERS
// The one-time seed can retain far more provenance than the live watchlist;
// this rejects an unexpected provider fan-out before it consumes a Worker isolate.
export const MAX_INSTRUMENT_CATALOG_ITEMS = 10_000
const CATALOG_BOUND_PARAMETERS_PER_ROW = 32
const CATALOG_ROWS_PER_STATEMENT = rowsPerD1Statement(CATALOG_BOUND_PARAMETERS_PER_ROW)

export type InstrumentCatalogRefresh = {
  missingSymbols: string[]
  receivedCount: number
  requestedCount: number
}

export type InstrumentCatalogLoader = (symbols: readonly string[]) => Promise<JsonValue>

// This persisted provider contract repeats the domain display-field widths and bounds the
// additional raw catalog labels before they enter D1; none is used to authorize a trade.
const InstrumentCatalogRecordSchema = InstrumentCatalogItemSchema.extend({
  active: z.boolean().nullable(),
  bypassManualReview: z.boolean().nullable(),
  countryOfTaxation: z.string().trim().min(1).max(128).nullable(),
  createdAt: z.string().datetime(),
  haltedAt: z.string().datetime().nullable(),
  identityRefreshedAt: z.string().datetime(),
  identitySource: z.enum(['equity-endpoint', 'watchlist-symbol']),
  instrumentSubType: z.string().trim().min(1).max(128).nullable(),
  instrumentType: z.literal('Equity'),
  isClosingOnly: z.boolean().nullable(),
  isFractionalQuantityEligible: z.boolean().nullable(),
  isIlliquid: z.boolean().nullable(),
  isOptionsClosingOnly: z.boolean().nullable(),
  marketTimeInstrumentCollection: z.string().trim().min(1).max(128).nullable(),
  overnightTradingPermitted: z.boolean().nullable(),
  preIpo: z.boolean().nullable(),
  source: z.literal('tastytrade'),
  statusRefreshedAt: z.string().datetime(),
  stopsTradingAt: z.string().datetime().nullable(),
  streamerSymbol: z.string().trim().min(1).max(128).nullable(),
  underlyingProductType: z.string().trim().min(1).max(128).nullable(),
  updatedAt: z.string().datetime(),
})

export type InstrumentCatalogRecord = z.infer<typeof InstrumentCatalogRecordSchema>

function optionalText(value: JsonValue, max: number, field: string): string | null {
  if (value === undefined || value === null) return null
  const text = jsonText(value)
  if (text === undefined) throw new Error(`InstrumentCatalog:${field}-invalid`)
  if (text.length > max) throw new Error(`InstrumentCatalog:${field}-too-long`)
  return text
}

function optionalBoolean(value: JsonValue, field: string): boolean | null {
  if (value === undefined || value === null) return null
  const parsed = z.boolean().safeParse(value)
  if (!parsed.success) throw new Error(`InstrumentCatalog:${field}-invalid`)
  return parsed.data
}

function optionalNumber(value: JsonValue, field: string): number | null {
  if (value === undefined || value === null) return null
  const parsed = jsonNumber(value)
  if (parsed === undefined) throw new Error(`InstrumentCatalog:${field}-invalid`)
  return parsed
}

function optionalDateTime(value: JsonValue, field: string): string | null {
  const text = optionalText(value, 64, field)
  if (text === null) return null
  const epoch = Date.parse(text)
  if (!Number.isFinite(epoch)) throw new Error(`InstrumentCatalog:${field}-invalid`)
  return new Date(epoch).toISOString()
}

export function instrumentCatalogFromPayload(
  payload: JsonValue,
  requestedSymbols: readonly string[],
  now = new Date(),
): InstrumentCatalogRecord[] {
  const requested = new Set(requestedSymbols.map((symbol) => EquitySymbolSchema.parse(symbol)))
  const body = jsonObject(payload)
  const single = jsonObject(body?.data ?? payload)
  const rows = envelopeRows(payload) ?? (jsonText(single?.symbol) ? [single!] : undefined)
  if (!rows) throw new Error('InstrumentCatalog:invalid-response')
  const timestamp = now.toISOString()
  const seen = new Set<string>()
  return rows.map((candidate) => {
    const row = jsonObject(candidate)
    if (!row) throw new Error('InstrumentCatalog:invalid-row')
    const symbol = EquitySymbolSchema.parse(jsonText(row.symbol))
    if (!requested.has(symbol)) throw new Error('InstrumentCatalog:unexpected-symbol')
    if (seen.has(symbol)) throw new Error('InstrumentCatalog:duplicate-symbol')
    seen.add(symbol)
    if (jsonText(row['instrument-type']) !== 'Equity') {
      throw new Error('InstrumentCatalog:invalid-instrument-type')
    }
    return InstrumentCatalogRecordSchema.parse({
      active: optionalBoolean(row.active, 'active'),
      borrowRate: optionalNumber(row['borrow-rate'], 'borrow-rate'),
      bypassManualReview: optionalBoolean(row['bypass-manual-review'], 'bypass-manual-review'),
      countryOfIncorporation: optionalText(row['country-of-incorporation'], 128, 'country-of-incorporation'),
      countryOfTaxation: optionalText(row['country-of-taxation'], 128, 'country-of-taxation'),
      createdAt: timestamp,
      description: optionalText(row.description, 512, 'description'),
      haltedAt: optionalDateTime(row['halted-at'], 'halted-at'),
      identityRefreshedAt: timestamp,
      identitySource: 'equity-endpoint',
      instrumentSubType: optionalText(row['instrument-sub-type'], 128, 'instrument-sub-type'),
      instrumentType: 'Equity',
      isClosingOnly: optionalBoolean(row['is-closing-only'], 'is-closing-only'),
      isEtf: optionalBoolean(row['is-etf'], 'is-etf'),
      isFractionalQuantityEligible: optionalBoolean(
        row['is-fractional-quantity-eligible'],
        'is-fractional-quantity-eligible',
      ),
      isIlliquid: optionalBoolean(row['is-illiquid'], 'is-illiquid'),
      isIndex: optionalBoolean(row['is-index'], 'is-index'),
      isOptionsClosingOnly: optionalBoolean(row['is-options-closing-only'], 'is-options-closing-only'),
      lendability: optionalText(row.lendability, 128, 'lendability'),
      listedMarket: optionalText(row['listed-market'], 128, 'listed-market'),
      marketTimeInstrumentCollection: optionalText(
        row['market-time-instrument-collection'],
        128,
        'market-time-instrument-collection',
      ),
      overnightTradingPermitted: optionalBoolean(
        row['overnight-trading-permitted'],
        'overnight-trading-permitted',
      ),
      preIpo: optionalBoolean(row['pre-ipo'], 'pre-ipo'),
      resolutionStatus: 'resolved',
      shortDescription: optionalText(row['short-description'], 256, 'short-description'),
      source: 'tastytrade',
      statusRefreshedAt: timestamp,
      stopsTradingAt: optionalDateTime(row['stops-trading-at'], 'stops-trading-at'),
      streamerSymbol: optionalText(row['streamer-symbol'], 128, 'streamer-symbol'),
      symbol,
      underlyingProductType: optionalText(row['underlying-product-type'], 128, 'underlying-product-type'),
      updatedAt: timestamp,
    })
  })
}

function sqlBoolean(value: boolean | null): number | null {
  return value === null ? null : Number(value)
}

function catalogValues(item: InstrumentCatalogRecord): Array<number | null | string> {
  return [
    item.symbol, item.source, item.description, item.shortDescription, item.instrumentType,
    item.instrumentSubType, item.streamerSymbol, item.listedMarket, item.marketTimeInstrumentCollection,
    item.countryOfIncorporation, item.countryOfTaxation, item.underlyingProductType,
    sqlBoolean(item.isEtf), sqlBoolean(item.isIndex), sqlBoolean(item.preIpo), sqlBoolean(item.active),
    sqlBoolean(item.isClosingOnly), sqlBoolean(item.isOptionsClosingOnly), sqlBoolean(item.isIlliquid),
    sqlBoolean(item.isFractionalQuantityEligible), sqlBoolean(item.overnightTradingPermitted),
    sqlBoolean(item.bypassManualReview), item.haltedAt, item.stopsTradingAt, item.lendability,
    item.borrowRate, item.identityRefreshedAt, item.statusRefreshedAt, item.createdAt, item.updatedAt,
    item.resolutionStatus, item.identitySource,
  ]
}

const resolvedConflictClause = `ON CONFLICT(symbol) DO UPDATE SET
        source_name = excluded.source_name, description = excluded.description,
        short_description = excluded.short_description, instrument_type = excluded.instrument_type,
        instrument_sub_type = excluded.instrument_sub_type, streamer_symbol = excluded.streamer_symbol,
        listed_market = excluded.listed_market,
        market_time_instrument_collection = excluded.market_time_instrument_collection,
        country_of_incorporation = excluded.country_of_incorporation,
        country_of_taxation = excluded.country_of_taxation,
        underlying_product_type = excluded.underlying_product_type, is_etf = excluded.is_etf,
        is_index = excluded.is_index, pre_ipo = excluded.pre_ipo, active = excluded.active,
        is_closing_only = excluded.is_closing_only,
        is_options_closing_only = excluded.is_options_closing_only,
        is_illiquid = excluded.is_illiquid,
        is_fractional_quantity_eligible = excluded.is_fractional_quantity_eligible,
        overnight_trading_permitted = excluded.overnight_trading_permitted,
        bypass_manual_review = excluded.bypass_manual_review, halted_at = excluded.halted_at,
        stops_trading_at = excluded.stops_trading_at, lendability = excluded.lendability,
        borrow_rate = excluded.borrow_rate, identity_refreshed_at = excluded.identity_refreshed_at,
        status_refreshed_at = excluded.status_refreshed_at, updated_at = excluded.updated_at,
        resolution_status = excluded.resolution_status, identity_source = excluded.identity_source`

function catalogUpserts(
  db: D1Database,
  items: readonly InstrumentCatalogRecord[],
  conflictClause: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = []
  for (let start = 0; start < items.length; start += CATALOG_ROWS_PER_STATEMENT) {
    const chunk = items.slice(start, start + CATALOG_ROWS_PER_STATEMENT)
    const row = `(${Array.from({ length: CATALOG_BOUND_PARAMETERS_PER_ROW }, () => '?').join(', ')})`
    statements.push(db.prepare(
      `INSERT INTO instrument_catalog (
        symbol, source_name, description, short_description, instrument_type, instrument_sub_type,
        streamer_symbol, listed_market, market_time_instrument_collection, country_of_incorporation,
        country_of_taxation, underlying_product_type, is_etf, is_index, pre_ipo, active,
        is_closing_only, is_options_closing_only, is_illiquid, is_fractional_quantity_eligible,
        overnight_trading_permitted, bypass_manual_review, halted_at, stops_trading_at,
        lendability, borrow_rate, identity_refreshed_at, status_refreshed_at, created_at, updated_at,
        resolution_status, identity_source
      ) VALUES ${chunk.map(() => row).join(', ')}
      ${conflictClause}`,
    ).bind(...chunk.flatMap(catalogValues)))
  }
  return statements
}

export async function persistInstrumentCatalog(env: AppEnv, items: readonly InstrumentCatalogRecord[]): Promise<void> {
  if (!env.DB) throw new Error('InstrumentCatalog:store-unavailable')
  if (!items.length) return
  for (let start = 0; start < items.length; start += CATALOG_REFRESH_CHUNK_SIZE) {
    const chunk = items.slice(start, start + CATALOG_REFRESH_CHUNK_SIZE)
    const resolved = chunk.filter((item) => item.resolutionStatus === 'resolved')
    const unresolved = chunk.filter((item) => item.resolutionStatus === 'unresolved')
    // A missing provider row is evidence only that this refresh could not resolve
    // the symbol. It must never erase a previously resolved identity or tick table.
    await env.DB.batch([
      ...catalogUpserts(env.DB, resolved, resolvedConflictClause),
      ...catalogUpserts(env.DB, unresolved, 'ON CONFLICT(symbol) DO NOTHING'),
    ])
  }
}

const StoredCatalogRowSchema = z.object({
  active: z.number().int().min(0).max(1).nullable(),
  borrow_rate: z.number().finite().nullable(),
  bypass_manual_review: z.number().int().min(0).max(1).nullable(),
  country_of_incorporation: z.string().min(1).max(128).nullable(),
  country_of_taxation: z.string().min(1).max(128).nullable(),
  created_at: z.string().datetime(),
  description: z.string().min(1).max(512).nullable(),
  halted_at: z.string().datetime().nullable(),
  identity_refreshed_at: z.string().datetime(),
  identity_source: z.enum(['equity-endpoint', 'watchlist-symbol']),
  instrument_sub_type: z.string().min(1).max(128).nullable(),
  instrument_type: z.literal('Equity'),
  is_closing_only: z.number().int().min(0).max(1).nullable(),
  is_etf: z.number().int().min(0).max(1).nullable(),
  is_fractional_quantity_eligible: z.number().int().min(0).max(1).nullable(),
  is_illiquid: z.number().int().min(0).max(1).nullable(),
  is_index: z.number().int().min(0).max(1).nullable(),
  is_options_closing_only: z.number().int().min(0).max(1).nullable(),
  lendability: z.string().min(1).max(128).nullable(),
  listed_market: z.string().min(1).max(128).nullable(),
  market_time_instrument_collection: z.string().min(1).max(128).nullable(),
  overnight_trading_permitted: z.number().int().min(0).max(1).nullable(),
  pre_ipo: z.number().int().min(0).max(1).nullable(),
  resolution_status: z.enum(['resolved', 'unresolved']),
  short_description: z.string().min(1).max(256).nullable(),
  source_name: z.literal('tastytrade'),
  status_refreshed_at: z.string().datetime(),
  stops_trading_at: z.string().datetime().nullable(),
  streamer_symbol: z.string().min(1).max(128).nullable(),
  symbol: EquitySymbolSchema,
  underlying_product_type: z.string().min(1).max(128).nullable(),
  updated_at: z.string().datetime(),
})

function storedBoolean(value: number | null): boolean | null {
  return value === null ? null : value === 1
}

export async function readInstrumentCatalog(
  env: AppEnv,
  requestedSymbols: readonly string[],
): Promise<Map<string, InstrumentCatalogItem>> {
  if (!env.DB) throw new Error('InstrumentCatalog:store-unavailable')
  const symbols = [...new Set(requestedSymbols.map((symbol) => EquitySymbolSchema.parse(symbol)))]
  if (symbols.length > MAX_INSTRUMENT_CATALOG_ITEMS) throw new Error('InstrumentCatalog:too-many-symbols')
  if (!symbols.length) return new Map()
  const catalogRows: z.infer<typeof StoredCatalogRowSchema>[] = []
  for (let start = 0; start < symbols.length; start += SQL_SYMBOL_CHUNK_SIZE) {
    const chunk = symbols.slice(start, start + SQL_SYMBOL_CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(', ')
    const catalog = await env.DB.prepare(
      `SELECT * FROM instrument_catalog WHERE symbol IN (${placeholders})`,
    ).bind(...chunk).all()
    catalogRows.push(...z.array(StoredCatalogRowSchema).parse(catalog.results))
  }
  return new Map(catalogRows.map((row) => {
    const item = InstrumentCatalogItemSchema.parse({
      active: storedBoolean(row.active),
      borrowRate: row.borrow_rate,
      countryOfIncorporation: row.country_of_incorporation,
      description: row.description,
      isEtf: storedBoolean(row.is_etf),
      isIndex: storedBoolean(row.is_index),
      lendability: row.lendability,
      listedMarket: row.listed_market,
      resolutionStatus: row.resolution_status,
      shortDescription: row.short_description,
      symbol: row.symbol,
    })
    return [item.symbol, item]
  }))
}

export async function refreshInstrumentCatalog(
  env: AppEnv,
  requestedSymbols: readonly string[],
  load: InstrumentCatalogLoader,
  now = new Date(),
): Promise<InstrumentCatalogRefresh> {
  const { items, missingSymbols, requestedCount } = await loadInstrumentCatalog(requestedSymbols, load, now)
  await persistInstrumentCatalog(env, items)
  return { missingSymbols, receivedCount: items.length, requestedCount }
}

export async function loadInstrumentCatalog(
  requestedSymbols: readonly string[],
  load: InstrumentCatalogLoader,
  now = new Date(),
): Promise<{ items: InstrumentCatalogRecord[]; missingSymbols: string[]; requestedCount: number }> {
  const symbols = [...new Set(requestedSymbols.map((symbol) => EquitySymbolSchema.parse(symbol)))]
  if (symbols.length > MAX_INSTRUMENT_CATALOG_ITEMS) throw new Error('InstrumentCatalog:too-many-symbols')
  if (!symbols.length) return { items: [], missingSymbols: [], requestedCount: 0 }
  const received: InstrumentCatalogRecord[] = []
  for (let start = 0; start < symbols.length; start += CATALOG_REFRESH_CHUNK_SIZE) {
    const chunk = symbols.slice(start, start + CATALOG_REFRESH_CHUNK_SIZE)
    received.push(...instrumentCatalogFromPayload(await load(chunk), chunk, now))
  }
  const receivedSymbols = new Set(received.map((item) => item.symbol))
  return {
    items: received,
    missingSymbols: symbols.filter((symbol) => !receivedSymbols.has(symbol)),
    requestedCount: symbols.length,
  }
}

export async function missingInstrumentCatalogSymbols(env: AppEnv, symbols: readonly string[]): Promise<string[]> {
  const normalized = [...new Set(symbols.map((symbol) => EquitySymbolSchema.parse(symbol)))]
  const stored = await readInstrumentCatalog(env, normalized)
  return normalized.filter((symbol) => !stored.has(symbol))
}

export async function instrumentCatalogSymbolsNeedingResolution(
  env: AppEnv,
  symbols: readonly string[],
): Promise<string[]> {
  const normalized = [...new Set(symbols.map((symbol) => EquitySymbolSchema.parse(symbol)))]
  const stored = await readInstrumentCatalog(env, normalized)
  return normalized.filter((symbol) => stored.get(symbol)?.resolutionStatus !== 'resolved')
}

/** Honest placeholder for a tastytrade watchlist Equity absent from its instrument endpoints. */
export function unresolvedInstrumentCatalogItem(symbolValue: string, now = new Date()): InstrumentCatalogRecord {
  const symbol = EquitySymbolSchema.parse(symbolValue)
  const timestamp = now.toISOString()
  return InstrumentCatalogRecordSchema.parse({
    active: null,
    borrowRate: null,
    bypassManualReview: null,
    countryOfIncorporation: null,
    countryOfTaxation: null,
    createdAt: timestamp,
    description: null,
    haltedAt: null,
    identityRefreshedAt: timestamp,
    identitySource: 'watchlist-symbol',
    instrumentSubType: null,
    instrumentType: 'Equity',
    isClosingOnly: null,
    isEtf: null,
    isFractionalQuantityEligible: null,
    isIlliquid: null,
    isIndex: null,
    isOptionsClosingOnly: null,
    lendability: null,
    listedMarket: null,
    marketTimeInstrumentCollection: null,
    overnightTradingPermitted: null,
    preIpo: null,
    resolutionStatus: 'unresolved',
    shortDescription: null,
    source: 'tastytrade',
    statusRefreshedAt: timestamp,
    stopsTradingAt: null,
    streamerSymbol: null,
    symbol,
    underlyingProductType: null,
    updatedAt: timestamp,
  })
}
