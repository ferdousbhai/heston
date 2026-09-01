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
import { EquitySymbolSchema } from '../domain/instrument'
import { MAX_WATCHLIST_SYMBOLS } from '../domain/watchlist'
import { D1_MAX_BOUND_PARAMETERS } from './d1-limits'
import { type AppEnv } from './env'
import { MAX_INSTRUMENT_CATALOG_ITEMS } from './instrument-catalog'
import { publishInternalWatchlistUniverse } from './public-market-universe'
import { defineSeam, type SeamValue } from './seam'

// The seed import is a one-time parse of untrusted provider collections. These ceilings are
// isolate-memory and D1-write budgets; they do not constrain the finalized 100-symbol product list.
const MAX_SOURCE_LISTS_PER_KIND = 100
const MAX_ENTRIES_PER_SOURCE = 5_000
const MAX_TOTAL_SEED_ENTRIES = 50_000

/**
 * One definition of an eligible High Options Volume seed member. Pruning uses
 * this rank to decide which rows survive the cap and the focus read uses it to
 * order what is shown, so the two drifting apart would be a silent correctness
 * bug rather than a visible failure.
 */
const HIGH_OPTIONS_VOLUME_SOURCE = `
       FROM internal_watchlist_seed_entries e
       JOIN internal_watchlist_seed_sources s ON s.id = e.source_id
       JOIN instrument_catalog c ON c.symbol = upper(e.broker_symbol)
       WHERE e.instrument_type = 'Equity'
         AND s.source_kind = 'public' AND s.name = 'High Options Volume'
         AND c.resolution_status = 'resolved' AND c.active = 1
         AND coalesce(c.is_etf, 0) = 0 AND coalesce(c.is_index, 0) = 0
         AND coalesce(c.is_illiquid, 0) = 0 AND coalesce(c.is_closing_only, 0) = 0
         AND coalesce(c.is_options_closing_only, 0) = 0`
const MAX_CATALOG_CANDIDATES = MAX_INSTRUMENT_CATALOG_ITEMS
const MAX_SOURCE_METADATA_BYTES = 256_000
const MAX_ENTRY_METADATA_BYTES = 64_000
// A crashed one-time importer may be retried after this lease-like stale window.
const SEED_STALE_AFTER_MS = 10 * 60_000
// Split D1 batch calls and JSON-table payloads before request or statement allocation grows large.
const WRITE_BATCH_SIZE = 75
const SEED_JSON_CHUNK_BYTES = 512_000
// Reject a seed whose chunked write would consume an unexpectedly large part of one invocation.
const MAX_SEED_WRITE_STATEMENTS = 200
const MAX_SEED_MEMBERSHIPS_PER_SYMBOL = 2 * MAX_SOURCE_LISTS_PER_KIND

const SymbolSchema = EquitySymbolSchema
const INTERNAL_WATCHLIST_ORIGINS = [
  'tastytrade-seed',
  // A reader's lookup is the weakest live provenance: any other origin overwrites it,
  // and it overwrites none, so a searched symbol can never outrank a researched one.
  'visitor-search',
  'scheduled-research',
  'agent-discussion',
  'position-sync',
  'trade-intent',
  'owner',
] as const
const InternalWatchlistOriginSchema = z.enum(INTERNAL_WATCHLIST_ORIGINS)
const InternalWatchlistMutationOriginSchema = InternalWatchlistOriginSchema.exclude(['tastytrade-seed'])

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
  finalizedAt: string | null
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

async function requireImportedSeed(db: D1Database): Promise<void> {
  const seed = await db.prepare(
    `SELECT status FROM internal_watchlist_seed WHERE id = 'primary'`,
  ).first<{ status: string }>()
  if (seed?.status !== 'ready') throw new Error('InternalWatchlist:not-seeded')
}

async function requireFinalizedSeed(db: D1Database): Promise<void> {
  const seed = await db.prepare(
    `SELECT status, finalized_at FROM internal_watchlist_seed WHERE id = 'primary'`,
  ).first<{ finalized_at: string | null; status: string }>()
  if (seed?.status !== 'ready') throw new Error('InternalWatchlist:not-seeded')
  if (!seed.finalized_at) throw new Error('InternalWatchlist:not-finalized')
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

function jsonChunks<T>(rows: readonly T[]): string[] {
  const chunks: string[] = []
  const encoder = new TextEncoder()
  let current: string[] = []
  let currentBytes = 2
  for (const row of rows) {
    const encoded = JSON.stringify(row)
    const rowBytes = encoder.encode(encoded).byteLength
    const separatorBytes = current.length ? 1 : 0
    if (current.length && currentBytes + separatorBytes + rowBytes > SEED_JSON_CHUNK_BYTES) {
      chunks.push(`[${current.join(',')}]`)
      current = []
      currentBytes = 2
    }
    if (currentBytes + rowBytes > SEED_JSON_CHUNK_BYTES) {
      throw new Error('InternalWatchlist:seed-row-too-large')
    }
    current.push(encoded)
    currentBytes += (current.length > 1 ? 1 : 0) + rowBytes
  }
  if (current.length) chunks.push(`[${current.join(',')}]`)
  return chunks
}

async function claimSeed(db: D1Database, attemptId: string, now: Date): Promise<'claimed' | 'ready'> {
  const startedAt = now.toISOString()
  const staleBefore = new Date(now.getTime() - SEED_STALE_AFTER_MS).toISOString()
  const claim = await db.prepare(
    `INSERT INTO internal_watchlist_seed (id, status, attempt_id, started_at)
     VALUES ('primary', 'seeding', ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = 'seeding', attempt_id = excluded.attempt_id, started_at = excluded.started_at,
       seeded_at = NULL, finalized_at = NULL, error_code = NULL
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
  if (seed.items.length > MAX_INSTRUMENT_CATALOG_ITEMS) {
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
  const sourceRows = seed.sources.map((source) => ({
    id: source.id,
    kind: source.kind,
    metadataJson: source.metadataJson,
    name: source.name,
    sourceIndex: source.sourceIndex,
  }))
  const entryRows = seed.sources.flatMap((source) => source.entries.map((entry) => ({
    brokerSymbol: entry.brokerSymbol,
    entryIndex: entry.entryIndex,
    instrumentType: entry.instrumentType,
    metadataJson: entry.metadataJson,
    sourceId: source.id,
  })))
  const sourceStatements = jsonChunks(sourceRows).map((chunk) => db.prepare(
      `INSERT INTO internal_watchlist_seed_sources
        (id, source_kind, source_index, name, metadata_json)
       SELECT
         json_extract(value, '$.id'),
         json_extract(value, '$.kind'),
         CAST(json_extract(value, '$.sourceIndex') AS INTEGER),
         json_extract(value, '$.name'),
         json_extract(value, '$.metadataJson')
       FROM json_each(?)
       WHERE EXISTS (SELECT 1 FROM internal_watchlist_seed
         WHERE id = 'primary' AND status = 'seeding' AND attempt_id = ?)`,
    ).bind(chunk, attemptId))
  const entryStatements = jsonChunks(entryRows).map((chunk) => db.prepare(
        `INSERT INTO internal_watchlist_seed_entries
          (source_id, entry_index, broker_symbol, instrument_type, metadata_json)
         SELECT
           json_extract(value, '$.sourceId'),
           CAST(json_extract(value, '$.entryIndex') AS INTEGER),
           json_extract(value, '$.brokerSymbol'),
           json_extract(value, '$.instrumentType'),
           json_extract(value, '$.metadataJson')
         FROM json_each(?)
         WHERE EXISTS (SELECT 1 FROM internal_watchlist_seed
           WHERE id = 'primary' AND status = 'seeding' AND attempt_id = ?)`,
      ).bind(chunk, attemptId))
  if (sourceStatements.length + entryStatements.length > MAX_SEED_WRITE_STATEMENTS) {
    throw new Error('InternalWatchlist:seed-write-budget-exceeded')
  }
  await runBatches(db, sourceStatements)
  await runBatches(db, entryStatements)
  const timestamp = now.toISOString()
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

/** Stable bootstrap candidates survive any position-aware live-list pruning. */
export async function readInternalWatchlistCatalogCandidates(env: AppEnv): Promise<string[]> {
  const db = requiredDatabase(env)
  await requireImportedSeed(db)
  const result = await db.prepare(
    `SELECT DISTINCT upper(broker_symbol) AS symbol
     FROM internal_watchlist_seed_entries
     WHERE instrument_type = 'Equity'
       AND broker_symbol GLOB '[A-Za-z]*'
       AND broker_symbol NOT GLOB '*[^A-Za-z.]*'
       AND length(broker_symbol) BETWEEN 1 AND 8
     ORDER BY symbol ASC LIMIT ${MAX_CATALOG_CANDIDATES + 1}`,
  ).all<{ symbol: string }>()
  const symbols = z.array(z.object({ symbol: SymbolSchema })).max(MAX_CATALOG_CANDIDATES).parse(result.results)
  return symbols.map((row) => row.symbol)
}

function restoreSeedStatement(db: D1Database, timestamp: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO internal_watchlist_items
       (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
     SELECT symbol, 'Equity', 'tastytrade-seed',
       json_object('seedSourceIds', json_group_array(source_id)), ?, ?
     FROM (
       SELECT DISTINCT upper(e.broker_symbol) AS symbol, e.source_id
       FROM internal_watchlist_seed_entries e
       WHERE e.instrument_type = 'Equity'
         AND e.broker_symbol GLOB '[A-Za-z]*'
         AND e.broker_symbol NOT GLOB '*[^A-Za-z.]*'
         AND length(e.broker_symbol) BETWEEN 1 AND 8
       ORDER BY e.source_id ASC
     )
     GROUP BY symbol
     HAVING true
       AND EXISTS (
         SELECT 1 FROM internal_watchlist_seed
         WHERE id = 'primary' AND status = 'ready' AND finalized_at IS NULL
       )
     ON CONFLICT(symbol) DO NOTHING`,
  ).bind(timestamp, timestamp)
}

function pruneStatement(
  db: D1Database,
  limit: number,
  prioritySymbols: readonly string[],
  onlyWhileUnfinalized = false,
): D1PreparedStatement {
  const boundedLimit = Math.min(MAX_WATCHLIST_SYMBOLS, Math.max(1, Math.trunc(limit)))
  // Every priority symbol is a bound parameter, so this list is capped by D1 rather
  // than by the watchlist: the rest still rank by origin and recency.
  const priority = normalizedSymbols(prioritySymbols).slice(0, D1_MAX_BOUND_PARAMETERS)
  const dynamicPriority = priority.length
    ? `WHEN symbol IN (${priority.map(() => '?').join(', ')}) THEN 0`
    : ''
  return db.prepare(
    `WITH private_symbols AS (
       SELECT DISTINCT upper(e.broker_symbol) AS symbol
       FROM internal_watchlist_seed_entries e
       JOIN internal_watchlist_seed_sources s ON s.id = e.source_id
       WHERE e.instrument_type = 'Equity' AND s.source_kind = 'private'
     ),
     volume_symbols AS (
       SELECT upper(e.broker_symbol) AS symbol, min(e.entry_index) AS volume_rank
       ${HIGH_OPTIONS_VOLUME_SOURCE}
       GROUP BY upper(e.broker_symbol)
     ),
     ranked AS (
       SELECT i.symbol, i.origin, i.updated_at,
         p.symbol IS NOT NULL AS private_member, v.volume_rank
       FROM internal_watchlist_items i
       LEFT JOIN private_symbols p ON p.symbol = i.symbol
       LEFT JOIN volume_symbols v ON v.symbol = i.symbol
     )
     DELETE FROM internal_watchlist_items
     WHERE origin IN ('tastytrade-seed', 'visitor-search')
       ${onlyWhileUnfinalized ? `AND EXISTS (
         SELECT 1 FROM internal_watchlist_seed
         WHERE id = 'primary' AND status = 'ready' AND finalized_at IS NULL
       )` : ''}
       AND symbol NOT IN (
       SELECT symbol FROM ranked
       ORDER BY CASE
         ${dynamicPriority}
         WHEN origin = 'owner' THEN 1
         WHEN origin = 'visitor-search' THEN 5
         WHEN origin <> 'tastytrade-seed' THEN 2
         WHEN private_member THEN 3
         WHEN volume_rank IS NOT NULL THEN 4
         ELSE 5
       END,
       coalesce(volume_rank, 9223372036854775807), updated_at DESC, symbol ASC
       LIMIT ${boundedLimit}
     )`,
  ).bind(...priority)
}

function originPriority(origin: InternalWatchlistOrigin): number {
  return INTERNAL_WATCHLIST_ORIGINS.indexOf(origin)
}

const storedOriginPrioritySql = `CASE internal_watchlist_items.origin ${INTERNAL_WATCHLIST_ORIGINS
  .map((origin, priority) => `WHEN '${origin}' THEN ${priority}`)
  .join(' ')} END`

function upsertSymbolsStatement(
  db: D1Database,
  symbols: readonly string[],
  origin: Exclude<InternalWatchlistOrigin, 'tastytrade-seed'>,
  timestamp: string,
  onlyWhileUnfinalized = false,
): D1PreparedStatement {
  const priority = originPriority(origin)
  return db.prepare(
    `WITH input AS (
       SELECT CAST(key AS INTEGER) AS input_index, value AS symbol
       FROM json_each(?)
     ), ranked_input AS (
       SELECT input_index, symbol,
         CASE WHEN EXISTS (
           SELECT 1 FROM internal_watchlist_items i
           WHERE i.symbol = input.symbol AND i.origin <> 'tastytrade-seed'
         ) THEN 0 ELSE 1 END AS needs_slot
       FROM input
     ), admitted AS (
       SELECT input_index, symbol FROM (
         SELECT input_index, symbol, needs_slot,
           sum(needs_slot) OVER (ORDER BY input_index ASC) AS slot_number
         FROM ranked_input
       )
       WHERE needs_slot = 0 OR slot_number <= max(0, ${MAX_WATCHLIST_SYMBOLS} - (
         SELECT count(*) FROM internal_watchlist_items WHERE origin <> 'tastytrade-seed'
       ))
     )
     INSERT INTO internal_watchlist_items
       (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
     SELECT symbol, 'Equity', ?, '{}', ?, ? FROM admitted
     WHERE ${onlyWhileUnfinalized ? `EXISTS (
       SELECT 1 FROM internal_watchlist_seed
       WHERE id = 'primary' AND status = 'ready' AND finalized_at IS NULL
     )` : 'true'}
     ON CONFLICT(symbol) DO UPDATE SET
       origin = CASE WHEN ? > ${storedOriginPrioritySql}
         THEN excluded.origin ELSE internal_watchlist_items.origin END,
       updated_at = CASE WHEN ? >= ${storedOriginPrioritySql}
         THEN excluded.updated_at ELSE internal_watchlist_items.updated_at END`,
  ).bind(JSON.stringify(symbols), origin, timestamp, timestamp, priority, priority)
}

/**
 * Atomically materialize the one-time imported universe into its final bounded
 * live list. A completed finalization is immutable, so a later bootstrap rerun
 * can never resurrect an explicitly deleted seed member.
 */
export async function finalizeInternalWatchlist(
  env: AppEnv,
  positionSymbols: readonly string[],
  now = new Date(),
): Promise<{ finalized: boolean; kept: string[] }> {
  const db = requiredDatabase(env)
  await requireImportedSeed(db)
  const positions = normalizedSymbols(positionSymbols)
  if (positions.length > MAX_WATCHLIST_SYMBOLS) {
    throw new Error('InternalWatchlist:too-many-position-symbols')
  }
  const timestamp = now.toISOString()
  const statements = [
    db.prepare(
      `DELETE FROM internal_watchlist_items
       WHERE origin = 'tastytrade-seed'
         AND EXISTS (
           SELECT 1 FROM internal_watchlist_seed
           WHERE id = 'primary' AND status = 'ready' AND finalized_at IS NULL
         )`,
    ),
    restoreSeedStatement(db, timestamp),
    ...(positions.length ? [
      upsertSymbolsStatement(db, positions, 'position-sync', timestamp, true),
    ] : []),
    pruneStatement(db, MAX_WATCHLIST_SYMBOLS, positions, true),
    db.prepare(
      `UPDATE internal_watchlist_seed SET finalized_at = ?
       WHERE id = 'primary' AND status = 'ready' AND finalized_at IS NULL
         AND (SELECT count(*) FROM internal_watchlist_items) <= ${MAX_WATCHLIST_SYMBOLS}`,
    ).bind(timestamp),
  ]
  const results = await db.batch(statements)
  const finalized = results.at(-1)?.meta.changes === 1
  const state = await db.prepare(
    `SELECT finalized_at FROM internal_watchlist_seed WHERE id = 'primary' AND status = 'ready'`,
  ).first<{ finalized_at: string | null }>()
  if (!state?.finalized_at) throw new Error('InternalWatchlist:finalization-failed')
  await publishInternalWatchlistUniverse(env, now)
  return {
    finalized,
    kept: await readInternalWatchlistFocus(env, positions, MAX_WATCHLIST_SYMBOLS),
  }
}

/** Add or prioritize symbols while retaining immutable seed provenance and creation time. */
export async function ensureInternalWatchlistSymbols(
  env: AppEnv,
  symbols: readonly string[],
  origin: Exclude<InternalWatchlistOrigin, 'tastytrade-seed'>,
  now = new Date(),
): Promise<string[]> {
  const db = requiredDatabase(env)
  await requireFinalizedSeed(db)
  const normalized = normalizedSymbols(symbols)
  if (!normalized.length) return []
  if (normalized.length > MAX_WATCHLIST_SYMBOLS) throw new Error('InternalWatchlist:too-many-symbols')
  const timestamp = now.toISOString()
  const parsedOrigin = InternalWatchlistMutationOriginSchema.parse(origin)
  // D1 batch executes transactionally. Ranking inside the same batch prevents
  // concurrent additions from observing 99 rows and jointly exceeding the cap.
  // New symbols are admitted in input order up to the protected-row capacity;
  // the only automatic eviction target remains a retained broker-seed row.
  await db.batch([
    upsertSymbolsStatement(db, normalized, parsedOrigin, timestamp),
    pruneStatement(db, MAX_WATCHLIST_SYMBOLS, []),
  ])
  const kept = await focusFromStore(db, [], MAX_WATCHLIST_SYMBOLS)
  await publishInternalWatchlistUniverse(env, now)
  const retained = new Set(kept)
  return normalized.filter((symbol) => retained.has(symbol))
}

export async function removeInternalWatchlistSymbols(env: AppEnv, symbols: readonly string[]): Promise<string[]> {
  const db = requiredDatabase(env)
  await requireFinalizedSeed(db)
  const normalized = normalizedSymbols(symbols)
  if (!normalized.length) return []
  if (normalized.length > MAX_WATCHLIST_SYMBOLS) throw new Error('InternalWatchlist:too-many-symbols')
  const results = await db.batch(normalized.map((symbol) => (
    db.prepare('DELETE FROM internal_watchlist_items WHERE symbol = ?').bind(symbol)
  )))
  const removed = normalized.filter((_, index) => results[index]?.meta.changes === 1)
  // Republish even for an idempotent retry. If the first attempt committed its
  // deletion but publication failed, the retry repairs the public projection.
  await publishInternalWatchlistUniverse(env)
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
  await requireFinalizedSeed(db)
  const items = await readItems(db)
  if (items.length > MAX_WATCHLIST_SYMBOLS) throw new Error('InternalWatchlist:invalid-store')
  return items
}

/**
 * The ungated read. Callers that already hold the finalized-seed gate use this
 * so one request does not pay for the same gate query two or three times; the
 * gate itself stays mandatory on every entry point that is reached directly.
 */
async function readItems(db: D1Database): Promise<InternalWatchlistItem[]> {
  const result = await db.prepare(
    `SELECT symbol, instrument_type, origin, metadata_json, created_at, updated_at
     FROM internal_watchlist_items ORDER BY symbol ASC LIMIT ${MAX_INSTRUMENT_CATALOG_ITEMS + 1}`,
  ).all()
  if (!Array.isArray(result.results) || result.results.length > MAX_INSTRUMENT_CATALOG_ITEMS) {
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
  limit = MAX_WATCHLIST_SYMBOLS,
  highOptionsVolumeSymbols: readonly string[] = [],
): string[] {
  const positions = new Set(normalizedSymbols(positionSymbols))
  const volumeRank = new Map(normalizedSymbols(highOptionsVolumeSymbols)
    .map((symbol, index) => [symbol, index]))
  const priority = (item: InternalWatchlistItem) => positions.has(item.symbol)
    ? 0
    : item.origin === 'owner'
      ? 1
      : item.origin === 'visitor-search'
        // A reader's lookup earns its place on the list but yields to every curated
        // name on it, so trimming the list back drops the searches first.
        ? 5
        : item.origin !== 'tastytrade-seed'
          ? 2
          : hasPrivateSeedMembership(item)
            ? 3
            : volumeRank.has(item.symbol) ? 4 : 6
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
  limit = MAX_WATCHLIST_SYMBOLS,
): Promise<string[]> {
  const db = requiredDatabase(env)
  await requireFinalizedSeed(db)
  return focusFromStore(db, positionSymbols, limit)
}

async function focusFromStore(
  db: D1Database,
  positionSymbols: readonly string[],
  limit: number,
): Promise<string[]> {
  const [items, result] = await Promise.all([
    readItems(db),
    db.prepare(
      `SELECT upper(e.broker_symbol) AS symbol
       ${HIGH_OPTIONS_VOLUME_SOURCE}
       GROUP BY upper(e.broker_symbol)
       ORDER BY min(e.entry_index) ASC
       LIMIT ${MAX_WATCHLIST_SYMBOLS}`,
    ).all<{ symbol: string }>(),
  ])
  const highOptionsVolumeSymbols = z.array(z.object({ symbol: SymbolSchema }))
    .max(MAX_WATCHLIST_SYMBOLS)
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
  limit = MAX_WATCHLIST_SYMBOLS,
): Promise<{ kept: string[]; removedCount: number }> {
  const db = requiredDatabase(env)
  await requireFinalizedSeed(db)
  const result = await pruneStatement(db, limit, []).run()
  const retained = await focusFromStore(db, [], limit)
  await publishInternalWatchlistUniverse(env)
  return { kept: retained, removedCount: result.meta.changes }
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
     LIMIT ${MAX_SEED_MEMBERSHIPS_PER_SYMBOL + 1}`,
  ).bind(symbol).all()
  if (!Array.isArray(result.results) || result.results.length > MAX_SEED_MEMBERSHIPS_PER_SYMBOL) {
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
       (SELECT finalized_at FROM internal_watchlist_seed WHERE id = 'primary') AS finalized_at,
       (SELECT count(*) FROM internal_watchlist_seed_sources WHERE source_kind = 'private') AS private_source_count,
       (SELECT count(*) FROM internal_watchlist_seed_sources WHERE source_kind = 'public') AS public_source_count,
       (SELECT count(*) FROM internal_watchlist_seed_entries) AS entry_count,
       (SELECT count(*) FROM internal_watchlist_items) AS item_count`,
  ).first<{
    entry_count: number
    finalized_at: string | null
    item_count: number
    private_source_count: number
    public_source_count: number
    seeded_at: string | null
    status: string | null
  }>()
  const status = z.enum(['seeding', 'ready', 'failed']).nullable().parse(row?.status ?? null) ?? 'missing'
  return {
    entryCount: z.number().int().nonnegative().parse(row?.entry_count ?? 0),
    finalizedAt: z.string().nullable().parse(row?.finalized_at ?? null),
    itemCount: z.number().int().nonnegative().parse(row?.item_count ?? 0),
    privateSourceCount: z.number().int().nonnegative().parse(row?.private_source_count ?? 0),
    publicSourceCount: z.number().int().nonnegative().parse(row?.public_source_count ?? 0),
    seededAt: z.string().nullable().parse(row?.seeded_at ?? null),
    status,
  }
}

const internalWatchlistWriterSeam = defineSeam(() => ({ ensureSymbols: ensureInternalWatchlistSymbols }))

export type InternalWatchlistWriter = SeamValue<typeof internalWatchlistWriterSeam>

export const internalWatchlistWriter = internalWatchlistWriterSeam.current

export const setInternalWatchlistWriter = internalWatchlistWriterSeam.set

export const resetInternalWatchlistWriter = internalWatchlistWriterSeam.reset
