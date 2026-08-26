import { z } from 'zod'

import {
  EquitySymbolSchema,
  InstrumentCatalogItemSchema,
  type InstrumentCatalogItem,
  type InstrumentTickSize,
} from '../domain/instrument'
import {
  envelopeRows,
  JsonArraySchema,
  jsonNumber,
  jsonObject,
  jsonText,
  type JsonValue,
} from '../domain/json-payload'
import { type AppEnv } from './env'

const PROVIDER_CHUNK_SIZE = 100
const SQL_SYMBOL_CHUNK_SIZE = 90
const MAX_TICK_TIERS_PER_KIND = 50
const MAX_CATALOG_ITEMS = 10_000
const MAX_BATCH_STATEMENTS = 75

export type InstrumentCatalogRefresh = {
  missingSymbols: string[]
  receivedCount: number
  requestedCount: number
}

export type InstrumentCatalogLoader = (symbols: readonly string[]) => Promise<JsonValue>

function optionalText(value: JsonValue, max: number, field: string): string | null {
  const text = jsonText(value)
  if (text === undefined) return null
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

function optionalThreshold(value: JsonValue, field: string): number | null {
  if (jsonText(value)?.toLowerCase() === 'infinity') return null
  return optionalNumber(value, field)
}

function optionalDateTime(value: JsonValue, field: string): string | null {
  const text = optionalText(value, 64, field)
  if (text === null) return null
  const epoch = Date.parse(text)
  if (!Number.isFinite(epoch)) throw new Error(`InstrumentCatalog:${field}-invalid`)
  return new Date(epoch).toISOString()
}

function tickObjects(value: JsonValue, field: string): JsonValue[] {
  if (value === undefined || value === null) return []
  const rows = JsonArraySchema.safeParse(value).data ?? [value]
  if (rows.length > MAX_TICK_TIERS_PER_KIND) throw new Error(`InstrumentCatalog:${field}-too-many`)
  return rows
}

function tickSizes(value: JsonValue, kind: InstrumentTickSize['kind']): InstrumentTickSize[] {
  return tickObjects(value, `${kind}-tick-sizes`).map((candidate, tierIndex) => {
    const row = jsonObject(candidate)
    if (!row) throw new Error(`InstrumentCatalog:${kind}-tick-size-invalid`)
    const tickValue = jsonNumber(row.value)
    if (tickValue === undefined || tickValue <= 0) {
      throw new Error(`InstrumentCatalog:${kind}-tick-value-invalid`)
    }
    return {
      appliesToSymbol: optionalText(row.symbol, 128, `${kind}-tick-symbol`),
      kind,
      threshold: optionalThreshold(row.threshold, `${kind}-tick-threshold`),
      tierIndex,
      value: tickValue,
    }
  })
}

/** Parse the complete interesting subset of tastytrade's documented Equity model. */
export function instrumentCatalogFromPayload(
  payload: JsonValue,
  requestedSymbols: readonly string[],
  now = new Date(),
): InstrumentCatalogItem[] {
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
    return InstrumentCatalogItemSchema.parse({
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
      tickSizes: [
        ...tickSizes(row['tick-sizes'], 'equity'),
        ...tickSizes(row['option-tick-sizes'], 'option'),
      ],
      underlyingProductType: optionalText(row['underlying-product-type'], 128, 'underlying-product-type'),
      updatedAt: timestamp,
    })
  })
}

function sqlBoolean(value: boolean | null): number | null {
  return value === null ? null : Number(value)
}

async function runGroups(db: D1Database, groups: readonly D1PreparedStatement[][]): Promise<void> {
  let batch: D1PreparedStatement[] = []
  for (const group of groups) {
    if (group.length > MAX_BATCH_STATEMENTS) throw new Error('InstrumentCatalog:too-many-tick-tiers')
    if (batch.length + group.length > MAX_BATCH_STATEMENTS) {
      await db.batch(batch)
      batch = []
    }
    batch.push(...group)
  }
  if (batch.length) await db.batch(batch)
}

export async function persistInstrumentCatalog(env: AppEnv, items: readonly InstrumentCatalogItem[]): Promise<void> {
  if (!env.DB) throw new Error('InstrumentCatalog:store-unavailable')
  const groups = items.map((item) => {
    const upsert = env.DB!.prepare(
      `INSERT INTO instrument_catalog (
        symbol, source_name, description, short_description, instrument_type, instrument_sub_type,
        streamer_symbol, listed_market, market_time_instrument_collection, country_of_incorporation,
        country_of_taxation, underlying_product_type, is_etf, is_index, pre_ipo, active,
        is_closing_only, is_options_closing_only, is_illiquid, is_fractional_quantity_eligible,
        overnight_trading_permitted, bypass_manual_review, halted_at, stops_trading_at,
        lendability, borrow_rate, identity_refreshed_at, status_refreshed_at, created_at, updated_at,
        resolution_status, identity_source
      ) VALUES (${Array.from({ length: 32 }, () => '?').join(', ')})
      ON CONFLICT(symbol) DO UPDATE SET
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
        resolution_status = excluded.resolution_status, identity_source = excluded.identity_source`,
    ).bind(
      item.symbol, item.source, item.description, item.shortDescription, item.instrumentType,
      item.instrumentSubType, item.streamerSymbol, item.listedMarket, item.marketTimeInstrumentCollection,
      item.countryOfIncorporation, item.countryOfTaxation, item.underlyingProductType,
      sqlBoolean(item.isEtf), sqlBoolean(item.isIndex), sqlBoolean(item.preIpo), sqlBoolean(item.active),
      sqlBoolean(item.isClosingOnly), sqlBoolean(item.isOptionsClosingOnly), sqlBoolean(item.isIlliquid),
      sqlBoolean(item.isFractionalQuantityEligible), sqlBoolean(item.overnightTradingPermitted),
      sqlBoolean(item.bypassManualReview), item.haltedAt, item.stopsTradingAt, item.lendability,
      item.borrowRate, item.identityRefreshedAt, item.statusRefreshedAt, item.createdAt, item.updatedAt,
      item.resolutionStatus, item.identitySource,
    )
    const replaceTicks = [
      env.DB!.prepare('DELETE FROM instrument_tick_sizes WHERE symbol = ?').bind(item.symbol),
      ...item.tickSizes.map((tick) => env.DB!.prepare(
        `INSERT INTO instrument_tick_sizes
          (symbol, kind, tier_index, applies_to_symbol, threshold, tick_value)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(item.symbol, tick.kind, tick.tierIndex, tick.appliesToSymbol, tick.threshold, tick.value)),
    ]
    return [upsert, ...replaceTicks]
  })
  await runGroups(env.DB, groups)
}

const StoredCatalogRowSchema = z.object({
  active: z.number().int().min(0).max(1).nullable(),
  borrow_rate: z.number().finite().nullable(),
  bypass_manual_review: z.number().int().min(0).max(1).nullable(),
  country_of_incorporation: z.string().nullable(),
  country_of_taxation: z.string().nullable(),
  created_at: z.string(),
  description: z.string().nullable(),
  halted_at: z.string().nullable(),
  identity_refreshed_at: z.string(),
  identity_source: z.enum(['equity-endpoint', 'watchlist-symbol']),
  instrument_sub_type: z.string().nullable(),
  instrument_type: z.literal('Equity'),
  is_closing_only: z.number().int().min(0).max(1).nullable(),
  is_etf: z.number().int().min(0).max(1).nullable(),
  is_fractional_quantity_eligible: z.number().int().min(0).max(1).nullable(),
  is_illiquid: z.number().int().min(0).max(1).nullable(),
  is_index: z.number().int().min(0).max(1).nullable(),
  is_options_closing_only: z.number().int().min(0).max(1).nullable(),
  lendability: z.string().nullable(),
  listed_market: z.string().nullable(),
  market_time_instrument_collection: z.string().nullable(),
  overnight_trading_permitted: z.number().int().min(0).max(1).nullable(),
  pre_ipo: z.number().int().min(0).max(1).nullable(),
  resolution_status: z.enum(['resolved', 'unresolved']),
  short_description: z.string().nullable(),
  source_name: z.literal('tastytrade'),
  status_refreshed_at: z.string(),
  stops_trading_at: z.string().nullable(),
  streamer_symbol: z.string().nullable(),
  symbol: EquitySymbolSchema,
  underlying_product_type: z.string().nullable(),
  updated_at: z.string(),
})

const StoredTickRowSchema = z.object({
  applies_to_symbol: z.string().nullable(),
  kind: z.enum(['equity', 'option']),
  symbol: EquitySymbolSchema,
  threshold: z.number().finite().nullable(),
  tick_value: z.number().finite().positive(),
  tier_index: z.number().int().nonnegative(),
})

function storedBoolean(value: number | null): boolean | null {
  return value === null ? null : value === 1
}

export async function readInstrumentCatalog(
  env: AppEnv,
  requestedSymbols: readonly string[],
): Promise<Map<string, InstrumentCatalogItem>> {
  if (!env.DB) return new Map()
  const symbols = [...new Set(requestedSymbols.map((symbol) => EquitySymbolSchema.parse(symbol)))]
  if (symbols.length > MAX_CATALOG_ITEMS) throw new Error('InstrumentCatalog:too-many-symbols')
  if (!symbols.length) return new Map()
  const catalogRows: z.infer<typeof StoredCatalogRowSchema>[] = []
  const tickRows: z.infer<typeof StoredTickRowSchema>[] = []
  for (let start = 0; start < symbols.length; start += SQL_SYMBOL_CHUNK_SIZE) {
    const chunk = symbols.slice(start, start + SQL_SYMBOL_CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(', ')
    const [catalog, ticks] = await Promise.all([
      env.DB.prepare(`SELECT * FROM instrument_catalog WHERE symbol IN (${placeholders})`).bind(...chunk).all(),
      env.DB.prepare(
        `SELECT symbol, kind, tier_index, applies_to_symbol, threshold, tick_value
         FROM instrument_tick_sizes WHERE symbol IN (${placeholders})
         ORDER BY symbol, kind, tier_index`,
      ).bind(...chunk).all(),
    ])
    catalogRows.push(...z.array(StoredCatalogRowSchema).parse(catalog.results ?? []))
    tickRows.push(...z.array(StoredTickRowSchema).parse(ticks.results ?? []))
  }
  const ticksBySymbol = new Map<string, InstrumentTickSize[]>()
  for (const tick of tickRows) {
    const values = ticksBySymbol.get(tick.symbol) ?? []
    values.push({
      appliesToSymbol: tick.applies_to_symbol,
      kind: tick.kind,
      threshold: tick.threshold,
      tierIndex: tick.tier_index,
      value: tick.tick_value,
    })
    ticksBySymbol.set(tick.symbol, values)
  }
  return new Map(catalogRows.map((row) => {
    const item = InstrumentCatalogItemSchema.parse({
      active: storedBoolean(row.active),
      borrowRate: row.borrow_rate,
      bypassManualReview: storedBoolean(row.bypass_manual_review),
      countryOfIncorporation: row.country_of_incorporation,
      countryOfTaxation: row.country_of_taxation,
      createdAt: row.created_at,
      description: row.description,
      haltedAt: row.halted_at,
      identityRefreshedAt: row.identity_refreshed_at,
      identitySource: row.identity_source,
      instrumentSubType: row.instrument_sub_type,
      instrumentType: row.instrument_type,
      isClosingOnly: storedBoolean(row.is_closing_only),
      isEtf: storedBoolean(row.is_etf),
      isFractionalQuantityEligible: storedBoolean(row.is_fractional_quantity_eligible),
      isIlliquid: storedBoolean(row.is_illiquid),
      isIndex: storedBoolean(row.is_index),
      isOptionsClosingOnly: storedBoolean(row.is_options_closing_only),
      lendability: row.lendability,
      listedMarket: row.listed_market,
      marketTimeInstrumentCollection: row.market_time_instrument_collection,
      overnightTradingPermitted: storedBoolean(row.overnight_trading_permitted),
      preIpo: storedBoolean(row.pre_ipo),
      resolutionStatus: row.resolution_status,
      shortDescription: row.short_description,
      source: row.source_name,
      statusRefreshedAt: row.status_refreshed_at,
      stopsTradingAt: row.stops_trading_at,
      streamerSymbol: row.streamer_symbol,
      symbol: row.symbol,
      tickSizes: ticksBySymbol.get(row.symbol) ?? [],
      underlyingProductType: row.underlying_product_type,
      updatedAt: row.updated_at,
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
): Promise<{ items: InstrumentCatalogItem[]; missingSymbols: string[]; requestedCount: number }> {
  const symbols = [...new Set(requestedSymbols.map((symbol) => EquitySymbolSchema.parse(symbol)))]
  if (symbols.length > MAX_CATALOG_ITEMS) throw new Error('InstrumentCatalog:too-many-symbols')
  if (!symbols.length) return { items: [], missingSymbols: [], requestedCount: 0 }
  const received: InstrumentCatalogItem[] = []
  for (let start = 0; start < symbols.length; start += PROVIDER_CHUNK_SIZE) {
    const chunk = symbols.slice(start, start + PROVIDER_CHUNK_SIZE)
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

/** Honest placeholder for a tastytrade watchlist Equity absent from its instrument endpoints. */
export function unresolvedInstrumentCatalogItem(symbolValue: string, now = new Date()): InstrumentCatalogItem {
  const symbol = EquitySymbolSchema.parse(symbolValue)
  const timestamp = now.toISOString()
  return InstrumentCatalogItemSchema.parse({
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
    tickSizes: [],
    underlyingProductType: null,
    updatedAt: timestamp,
  })
}
