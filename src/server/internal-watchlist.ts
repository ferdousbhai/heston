import { z } from 'zod'

import {
  envelopeRows,
  JsonArraySchema,
  jsonObject,
  jsonObjectOrEmpty,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { type AppEnv } from './env'
import { mergePublicMarketUniverseSymbols } from './public-market-universe'

const MAX_SOURCE_LISTS_PER_KIND = 100
const MAX_ENTRIES_PER_SOURCE = 5_000
const MAX_TOTAL_SEED_ENTRIES = 50_000
const MAX_INTERNAL_ITEMS = 10_000
const MAX_MAINTAINED_ITEMS = 100
const MAX_SOURCE_METADATA_BYTES = 256_000
const MAX_ENTRY_METADATA_BYTES = 64_000
const SEED_STALE_AFTER_MS = 10 * 60_000
const WRITE_BATCH_SIZE = 75

const SymbolSchema = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z.]{0,7}$/)
const InternalWatchlistOriginSchema = z.enum([
  'tastytrade-seed',
  'owner',
  'agent-discussion',
  'scheduled-research',
  'trade-intent',
])

export type InternalWatchlistOrigin = z.infer<typeof InternalWatchlistOriginSchema>

export type InternalWatchlistItem = {
  createdAt: string
  instrumentType: string
  metadata: JsonObject
  origin: InternalWatchlistOrigin
  symbol: string
  updatedAt: string
}

export type InternalWatchlistSymbolDetails = InternalWatchlistItem & {
  seedMemberships: Array<{
    entryMetadata: JsonObject
    sourceKind: 'private' | 'public'
    sourceMetadata: JsonObject
    sourceName: string
  }>
}

type SeedSource = {
  entries: SeedEntry[]
  id: string
  kind: 'private' | 'public'
  metadataJson: string
  name: string
  sourceIndex: number
}

type SeedEntry = {
  brokerSymbol: string | null
  entryIndex: number
  instrumentType: string | null
  metadataJson: string
}

export type InternalWatchlistSeedPayloads = {
  privatePayload: JsonValue
  publicPayload: JsonValue
}

export type InternalWatchlistSeedPreview = {
  entryCount: number
  itemCount: number
  privateSourceCount: number
  publicSourceCount: number
}

type InternalWatchlistSeed = {
  items: Array<{ metadataJson: string; symbol: string }>
  sources: SeedSource[]
}

export type InternalWatchlistSeedAudit = {
  entryCount: number
  itemCount: number
  privateSourceCount: number
  publicSourceCount: number
  seededAt: string | null
  status: 'missing' | 'seeding' | 'ready' | 'failed'
}

function requiredDatabase(env: AppEnv): D1Database {
  if (!env.DB) throw new Error('InternalWatchlist:store-unavailable')
  return env.DB
}

async function requireReadySeed(db: D1Database): Promise<void> {
  const seed = await db.prepare(
    `SELECT status FROM internal_watchlist_seed WHERE id = 'primary'`,
  ).first<{ status: string }>()
  if (seed?.status !== 'ready') throw new Error('InternalWatchlist:not-seeded')
}

function serialized(value: JsonValue, label: string, maxBytes: number): string {
  const result = JSON.stringify(value)
  if (!result || new TextEncoder().encode(result).byteLength > maxBytes) {
    throw new Error(`InternalWatchlist:${label}-too-large`)
  }
  return result
}

function assertCompleteCollection(payload: JsonValue, rowCount: number, label: string): void {
  const body = jsonObjectOrEmpty(payload)
  const data = jsonObjectOrEmpty(body.data)
  const pagination = jsonObject(body.pagination ?? data.pagination)
  const rawTotal = pagination?.['total-items']
  if (rawTotal === undefined) return
  const total = z.union([z.number(), z.string().transform(Number)]).safeParse(rawTotal).data
  if (total === undefined || !Number.isSafeInteger(total) || total < 0 || total !== rowCount) {
    throw new Error(`InternalWatchlist:${label}-incomplete-response`)
  }
}

function sourceRows(payload: JsonValue, kind: 'private' | 'public'): SeedSource[] {
  const rows = envelopeRows(payload)
  if (!rows) throw new Error(`InternalWatchlist:${kind}-missing-collection`)
  if (rows.length > MAX_SOURCE_LISTS_PER_KIND) throw new Error(`InternalWatchlist:${kind}-too-many-lists`)
  assertCompleteCollection(payload, rows.length, kind)
  return rows.map((value, sourceIndex) => {
    const row = jsonObject(value)
    const name = jsonText(row?.name)
    const rawEntries = JsonArraySchema.safeParse(row?.['watchlist-entries']).data
    if (!row) throw new Error(`InternalWatchlist:${kind}-invalid-row`)
    if (!name || name.length > 256) throw new Error(`InternalWatchlist:${kind}-invalid-name`)
    if (!rawEntries) throw new Error(`InternalWatchlist:${kind}-missing-entries`)
    if (rawEntries.length > MAX_ENTRIES_PER_SOURCE) {
      throw new Error(`InternalWatchlist:${kind}-too-many-list-entries:${rawEntries.length}`)
    }
    const metadata: JsonObject = { ...row }
    delete metadata['watchlist-entries']
    const entries = rawEntries.map((rawEntry, entryIndex) => {
      const entry = jsonObject(rawEntry)
      if (!entry) throw new Error(`InternalWatchlist:${kind}-invalid-entry`)
      const brokerSymbol = jsonText(entry.symbol) ?? null
      const instrumentType = jsonText(entry['instrument-type']) ?? null
      if ((brokerSymbol?.length ?? 0) > 256 || (instrumentType?.length ?? 0) > 128) {
        throw new Error(`InternalWatchlist:${kind}-invalid-entry`)
      }
      return {
        brokerSymbol,
        entryIndex,
        instrumentType,
        metadataJson: serialized(entry, 'entry-metadata', MAX_ENTRY_METADATA_BYTES),
      }
    })
    return {
      entries,
      id: `tastytrade-${kind}-${sourceIndex}`,
      kind,
      metadataJson: serialized(metadata, 'source-metadata', MAX_SOURCE_METADATA_BYTES),
      name,
      sourceIndex,
    }
  })
}

/** Preserve every source row and entry while normalizing only Equity symbols into the live list. */
export function internalWatchlistSeedFromPayloads(payloads: InternalWatchlistSeedPayloads): InternalWatchlistSeed {
  const sources = [
    ...sourceRows(payloads.privatePayload, 'private'),
    ...sourceRows(payloads.publicPayload, 'public'),
  ]
  const entryCount = sources.reduce((sum, source) => sum + source.entries.length, 0)
  if (entryCount > MAX_TOTAL_SEED_ENTRIES) throw new Error(`InternalWatchlist:too-many-entries:${entryCount}`)

  const memberships = new Map<string, string[]>()
  for (const source of sources) {
    for (const entry of source.entries) {
      if (entry.instrumentType !== 'Equity' || !entry.brokerSymbol) continue
      const symbol = SymbolSchema.safeParse(entry.brokerSymbol.toUpperCase()).data
      if (!symbol) continue
      const sourceIds = memberships.get(symbol) ?? []
      if (!sourceIds.includes(source.id)) sourceIds.push(source.id)
      memberships.set(symbol, sourceIds)
    }
  }
  const items = [...memberships.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([symbol, sourceIds]) => ({
    symbol,
    metadataJson: JSON.stringify({ seedSourceIds: sourceIds }),
  }))
  return { items, sources }
}

export function previewInternalWatchlistSeed(payloads: InternalWatchlistSeedPayloads): InternalWatchlistSeedPreview {
  const seed = internalWatchlistSeedFromPayloads(payloads)
  return {
    entryCount: seed.sources.reduce((sum, source) => sum + source.entries.length, 0),
    itemCount: seed.items.length,
    privateSourceCount: seed.sources.filter((source) => source.kind === 'private').length,
    publicSourceCount: seed.sources.filter((source) => source.kind === 'public').length,
  }
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let start = 0; start < statements.length; start += WRITE_BATCH_SIZE) {
    await db.batch(statements.slice(start, start + WRITE_BATCH_SIZE))
  }
}

async function claimSeed(db: D1Database, attemptId: string, now: Date): Promise<'claimed' | 'ready'> {
  const startedAt = now.toISOString()
  const staleBefore = new Date(now.getTime() - SEED_STALE_AFTER_MS).toISOString()
  const claim = await db.prepare(
    `INSERT INTO internal_watchlist_seed (id, status, attempt_id, started_at)
     VALUES ('primary', 'seeding', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = 'seeding', attempt_id = excluded.attempt_id, started_at = excluded.started_at,
       seeded_at = NULL, error_code = NULL
     WHERE internal_watchlist_seed.status = 'failed'
        OR (internal_watchlist_seed.status = 'seeding' AND internal_watchlist_seed.started_at <= ?)`,
  ).bind(attemptId, startedAt, staleBefore).run()
  if (claim.meta.changes === 1) return 'claimed'
  const current = await db.prepare(
    `SELECT status FROM internal_watchlist_seed WHERE id = 'primary'`,
  ).first<{ status: string }>()
  if (current?.status === 'ready') return 'ready'
  throw new Error('InternalWatchlist:seed-in-progress')
}

async function persistSeed(
  db: D1Database,
  seed: InternalWatchlistSeed,
  attemptId: string,
  now: Date,
): Promise<void> {
  if (seed.items.length > MAX_INTERNAL_ITEMS) {
    throw new Error(`InternalWatchlist:too-many-items:${seed.items.length}`)
  }
  // A retry clears only broker-seeded rows. Owner/agent/research additions and the
  // immutable audit rows from a completed seed are never touched after `ready`.
  // Every write rechecks the attempt claim so an expired importer cannot overwrite
  // a newer importer that reclaimed and completed the multi-batch seed.
  await db.batch([
    db.prepare(
      `DELETE FROM internal_watchlist_seed_entries
       WHERE EXISTS (SELECT 1 FROM internal_watchlist_seed
         WHERE id = 'primary' AND status = 'seeding' AND attempt_id = ?)`,
    ).bind(attemptId),
    db.prepare(
      `DELETE FROM internal_watchlist_seed_sources
       WHERE EXISTS (SELECT 1 FROM internal_watchlist_seed
         WHERE id = 'primary' AND status = 'seeding' AND attempt_id = ?)`,
    ).bind(attemptId),
    db.prepare(
      `DELETE FROM internal_watchlist_items WHERE origin = 'tastytrade-seed'
       AND EXISTS (SELECT 1 FROM internal_watchlist_seed
         WHERE id = 'primary' AND status = 'seeding' AND attempt_id = ?)`,
    ).bind(attemptId),
  ])
  const sourceStatements: D1PreparedStatement[] = []
  for (const source of seed.sources) {
    sourceStatements.push(db.prepare(
      `INSERT INTO internal_watchlist_seed_sources
        (id, source_kind, source_index, name, metadata_json)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM internal_watchlist_seed
         WHERE id = 'primary' AND status = 'seeding' AND attempt_id = ?)`,
    ).bind(source.id, source.kind, source.sourceIndex, source.name, source.metadataJson, attemptId))
    for (const entry of source.entries) {
      sourceStatements.push(db.prepare(
        `INSERT INTO internal_watchlist_seed_entries
          (source_id, entry_index, broker_symbol, instrument_type, metadata_json)
         SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM internal_watchlist_seed
           WHERE id = 'primary' AND status = 'seeding' AND attempt_id = ?)`,
      ).bind(source.id, entry.entryIndex, entry.brokerSymbol, entry.instrumentType, entry.metadataJson, attemptId))
    }
  }
  await runBatches(db, sourceStatements)
  const timestamp = now.toISOString()
  await runBatches(db, seed.items.map((item) => db.prepare(
    `INSERT INTO internal_watchlist_items
      (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
     SELECT ?, 'Equity', 'tastytrade-seed', ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM internal_watchlist_seed
       WHERE id = 'primary' AND status = 'seeding' AND attempt_id = ?)
     ON CONFLICT(symbol) DO NOTHING`,
  ).bind(item.symbol, item.metadataJson, timestamp, timestamp, attemptId)))
  const completed = await db.prepare(
    `UPDATE internal_watchlist_seed
     SET status = 'ready', seeded_at = ?, error_code = NULL
     WHERE id = 'primary' AND status = 'seeding' AND attempt_id = ?`,
  ).bind(timestamp, attemptId).run()
  if (completed.meta.changes !== 1) throw new Error('InternalWatchlist:seed-claim-lost')
}

/** Run the tastytrade import once; a complete `ready` seed is never fetched again. */
export async function ensureInternalWatchlistSeeded(
  env: AppEnv,
  loadPayloads: () => Promise<InternalWatchlistSeedPayloads>,
  now = new Date(),
): Promise<void> {
  const db = requiredDatabase(env)
  const attemptId = crypto.randomUUID()
  if (await claimSeed(db, attemptId, now) === 'ready') return
  try {
    const seed = internalWatchlistSeedFromPayloads(await loadPayloads())
    await persistSeed(db, seed, attemptId, now)
  } catch (cause) {
    const errorCode = cause instanceof Error ? cause.message.slice(0, 160) : 'InternalWatchlist:seed-failed'
    await db.prepare(
      `UPDATE internal_watchlist_seed SET status = 'failed', error_code = ?
       WHERE id = 'primary' AND status = 'seeding' AND attempt_id = ?`,
    ).bind(errorCode, attemptId).run().catch(() => undefined)
    throw cause
  }
}

function normalizedSymbols(symbols: readonly string[]): string[] {
  return [...new Set(symbols.map((symbol) => SymbolSchema.safeParse(symbol).data).filter((symbol): symbol is string => Boolean(symbol)))]
}

/** Add or prioritize symbols while retaining immutable seed provenance and creation time. */
export async function ensureInternalWatchlistSymbols(
  env: AppEnv,
  symbols: readonly string[],
  origin: Exclude<InternalWatchlistOrigin, 'tastytrade-seed'>,
  now = new Date(),
): Promise<string[]> {
  const db = requiredDatabase(env)
  await requireReadySeed(db)
  const normalized = normalizedSymbols(symbols)
  if (!normalized.length) return []
  const existing = new Set((await readInternalWatchlist(env)).map((item) => item.symbol))
  const additions = normalized.filter((symbol) => !existing.has(symbol))
  if (existing.size + additions.length > MAX_INTERNAL_ITEMS) {
    throw new Error('InternalWatchlist:too-many-items')
  }
  const timestamp = now.toISOString()
  await runBatches(db, normalized.map((symbol) => db.prepare(
    `INSERT INTO internal_watchlist_items
      (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
     VALUES (?, 'Equity', ?, '{}', ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       origin = excluded.origin, updated_at = excluded.updated_at`,
  ).bind(symbol, InternalWatchlistOriginSchema.parse(origin), timestamp, timestamp)))
  if (existing.size + additions.length > MAX_MAINTAINED_ITEMS) {
    await pruneInternalWatchlistToFocus(env, MAX_MAINTAINED_ITEMS)
  }
  await mergePublicMarketUniverseSymbols(env, normalized)
  return normalized
}

export async function removeInternalWatchlistSymbols(env: AppEnv, symbols: readonly string[]): Promise<string[]> {
  const db = requiredDatabase(env)
  await requireReadySeed(db)
  const normalized = normalizedSymbols(symbols)
  if (!normalized.length) return []
  const removed: string[] = []
  for (const symbol of normalized) {
    const result = await db.prepare('DELETE FROM internal_watchlist_items WHERE symbol = ?').bind(symbol).run()
    if (result.meta.changes === 1) removed.push(symbol)
  }
  return removed
}

const StoredItemSchema = z.object({
  created_at: z.string().datetime(),
  instrument_type: z.string().min(1).max(128),
  metadata_json: z.string().max(MAX_SOURCE_METADATA_BYTES),
  origin: InternalWatchlistOriginSchema,
  symbol: SymbolSchema,
  updated_at: z.string().datetime(),
})

export async function readInternalWatchlist(env: AppEnv): Promise<InternalWatchlistItem[]> {
  const db = requiredDatabase(env)
  await requireReadySeed(db)
  const result = await db.prepare(
    `SELECT symbol, instrument_type, origin, metadata_json, created_at, updated_at
     FROM internal_watchlist_items ORDER BY symbol ASC LIMIT ${MAX_INTERNAL_ITEMS + 1}`,
  ).all()
  if (!Array.isArray(result.results) || result.results.length > MAX_INTERNAL_ITEMS) {
    throw new Error('InternalWatchlist:invalid-store')
  }
  return result.results.map((row) => {
    const parsed = StoredItemSchema.parse(row)
    const metadata = jsonObject(JSON.parse(parsed.metadata_json))
    if (!metadata) throw new Error('InternalWatchlist:invalid-metadata')
    return {
      createdAt: parsed.created_at,
      instrumentType: parsed.instrument_type,
      metadata,
      origin: parsed.origin,
      symbol: parsed.symbol,
      updatedAt: parsed.updated_at,
    }
  })
}

function hasPrivateSeedMembership(item: InternalWatchlistItem): boolean {
  const sourceIds = JsonArraySchema.safeParse(item.metadata.seedSourceIds).data ?? []
  return sourceIds.some((sourceId) => jsonText(sourceId)?.startsWith('tastytrade-private-'))
}

/**
 * Full broker provenance stays private. The public sees only the alphabetized
 * result of this bounded working set, never the priority that selected a symbol.
 */
export function selectInternalWatchlistFocus(
  items: readonly InternalWatchlistItem[],
  positionSymbols: readonly string[],
  limit = 100,
  highOptionsVolumeSymbols: readonly string[] = [],
): string[] {
  const positions = new Set(normalizedSymbols(positionSymbols))
  const volumeRank = new Map(normalizedSymbols(highOptionsVolumeSymbols)
    .map((symbol, index) => [symbol, index]))
  const priority = (item: InternalWatchlistItem) => positions.has(item.symbol)
    ? 0
    : item.origin === 'owner'
      ? 1
      : item.origin !== 'tastytrade-seed'
        ? 2
        : hasPrivateSeedMembership(item)
          ? 3
          : volumeRank.has(item.symbol) ? 4 : 5
  return [...items]
    .sort((left, right) => priority(left) - priority(right)
      || (volumeRank.get(left.symbol) ?? Number.MAX_SAFE_INTEGER)
        - (volumeRank.get(right.symbol) ?? Number.MAX_SAFE_INTEGER)
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.symbol.localeCompare(right.symbol))
    .slice(0, Math.max(0, limit))
    .map((item) => item.symbol)
}

/**
 * Select the source-neutral 100-name working set. The one-time retained broker
 * provenance supplies an options-volume rank, but neither the rank nor its
 * source crosses the server boundary.
 */
export async function readInternalWatchlistFocus(
  env: AppEnv,
  positionSymbols: readonly string[],
  limit = 100,
): Promise<string[]> {
  const db = requiredDatabase(env)
  const [items, result] = await Promise.all([
    readInternalWatchlist(env),
    db.prepare(
      `SELECT upper(e.broker_symbol) AS symbol
       FROM internal_watchlist_seed_entries e
       JOIN internal_watchlist_seed_sources s ON s.id = e.source_id
       JOIN instrument_catalog c ON c.symbol = upper(e.broker_symbol)
       WHERE s.source_kind = 'public'
         AND s.name = 'High Options Volume'
         AND e.instrument_type = 'Equity'
         AND c.resolution_status = 'resolved'
         AND c.active = 1
         AND coalesce(c.is_etf, 0) = 0
         AND coalesce(c.is_index, 0) = 0
         AND coalesce(c.is_illiquid, 0) = 0
         AND coalesce(c.is_closing_only, 0) = 0
         AND coalesce(c.is_options_closing_only, 0) = 0
       ORDER BY e.entry_index ASC
       LIMIT 500`,
    ).all<{ symbol: string }>(),
  ])
  const highOptionsVolumeSymbols = z.array(z.object({ symbol: SymbolSchema }))
    .max(500)
    .parse(result.results)
    .map((row) => row.symbol)
  return selectInternalWatchlistFocus(items, positionSymbols, limit, highOptionsVolumeSymbols)
}

/**
 * Remove only live maintained-list rows. The full one-time broker provenance and
 * instrument catalog remain intact, so this bounded operation is recoverable.
 */
export async function pruneInternalWatchlistToFocus(
  env: AppEnv,
  limit = MAX_MAINTAINED_ITEMS,
): Promise<{ kept: string[]; removedCount: number }> {
  const db = requiredDatabase(env)
  await requireReadySeed(db)
  const kept = await readInternalWatchlistFocus(env, [], limit)
  if (!kept.length) throw new Error('InternalWatchlist:empty-focus')
  const result = await db.prepare(
    `DELETE FROM internal_watchlist_items
     WHERE symbol NOT IN (${kept.map(() => '?').join(', ')})`,
  ).bind(...kept).run()
  return { kept, removedCount: result.meta.changes }
}

export async function readInternalWatchlistSymbolDetails(
  env: AppEnv,
  untrustedSymbol: string,
): Promise<InternalWatchlistSymbolDetails | undefined> {
  const symbol = SymbolSchema.parse(untrustedSymbol)
  const items = await readInternalWatchlist(env)
  const item = items.find((candidate) => candidate.symbol === symbol)
  if (!item) return undefined
  const result = await requiredDatabase(env).prepare(
    `SELECT s.source_kind, s.name, s.metadata_json AS source_metadata_json,
            e.metadata_json AS entry_metadata_json
     FROM internal_watchlist_seed_entries e
     JOIN internal_watchlist_seed_sources s ON s.id = e.source_id
     WHERE upper(e.broker_symbol) = ? AND e.instrument_type = 'Equity'
     ORDER BY s.source_kind ASC, s.source_index ASC, e.entry_index ASC
     LIMIT 101`,
  ).bind(symbol).all()
  if (!Array.isArray(result.results) || result.results.length > 100) {
    throw new Error('InternalWatchlist:invalid-provenance')
  }
  const seedMemberships = result.results.map((row) => {
    const parsed = z.object({
      entry_metadata_json: z.string().max(MAX_ENTRY_METADATA_BYTES),
      name: z.string().min(1).max(256),
      source_kind: z.enum(['private', 'public']),
      source_metadata_json: z.string().max(MAX_SOURCE_METADATA_BYTES),
    }).parse(row)
    const entryMetadata = jsonObject(JSON.parse(parsed.entry_metadata_json))
    const sourceMetadata = jsonObject(JSON.parse(parsed.source_metadata_json))
    if (!entryMetadata || !sourceMetadata) throw new Error('InternalWatchlist:invalid-provenance')
    return {
      entryMetadata,
      sourceKind: parsed.source_kind,
      sourceMetadata,
      sourceName: parsed.name,
    }
  })
  return { ...item, seedMemberships }
}

/** Bounded operational summary; raw tastytrade provenance remains private in D1. */
export async function readInternalWatchlistSeedAudit(env: AppEnv): Promise<InternalWatchlistSeedAudit> {
  const row = await requiredDatabase(env).prepare(
    `SELECT
       (SELECT status FROM internal_watchlist_seed WHERE id = 'primary') AS status,
       (SELECT seeded_at FROM internal_watchlist_seed WHERE id = 'primary') AS seeded_at,
       (SELECT count(*) FROM internal_watchlist_seed_sources WHERE source_kind = 'private') AS private_source_count,
       (SELECT count(*) FROM internal_watchlist_seed_sources WHERE source_kind = 'public') AS public_source_count,
       (SELECT count(*) FROM internal_watchlist_seed_entries) AS entry_count,
       (SELECT count(*) FROM internal_watchlist_items) AS item_count`,
  ).first<{
    entry_count: number
    item_count: number
    private_source_count: number
    public_source_count: number
    seeded_at: string | null
    status: string | null
  }>()
  const status = z.enum(['seeding', 'ready', 'failed']).nullable().parse(row?.status ?? null) ?? 'missing'
  return {
    entryCount: z.number().int().nonnegative().parse(row?.entry_count ?? 0),
    itemCount: z.number().int().nonnegative().parse(row?.item_count ?? 0),
    privateSourceCount: z.number().int().nonnegative().parse(row?.private_source_count ?? 0),
    publicSourceCount: z.number().int().nonnegative().parse(row?.public_source_count ?? 0),
    seededAt: z.string().nullable().parse(row?.seeded_at ?? null),
    status,
  }
}

/** Narrow production seam for code paths whose primary concern is not D1 persistence. */
function createInternalWatchlistWriter() {
  return { ensureSymbols: ensureInternalWatchlistSymbols }
}

export type InternalWatchlistWriter = ReturnType<typeof createInternalWatchlistWriter>

let installedInternalWatchlistWriter: InternalWatchlistWriter = createInternalWatchlistWriter()

export function internalWatchlistWriter(): InternalWatchlistWriter {
  return installedInternalWatchlistWriter
}

export function setInternalWatchlistWriter(next: InternalWatchlistWriter): void {
  installedInternalWatchlistWriter = next
}

export function resetInternalWatchlistWriter(): void {
  installedInternalWatchlistWriter = createInternalWatchlistWriter()
}
