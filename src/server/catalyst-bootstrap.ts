import { z } from 'zod'

import { CatalystKindSchema, CatalystSchema, CODEX_WEB_CATALYST_ID_PREFIX, marketDate, type Catalyst } from '../domain/catalyst'
import { toError } from '../domain/failure'
import { EquitySymbolSchema, instrumentDisplayName, type InstrumentCatalogItem } from '../domain/instrument'
import { isValidIsoDate } from '../domain/iso-date'
import { type JsonValue } from '../domain/json-payload'
import { MAX_WATCHLIST_SYMBOLS } from '../domain/watchlist'
import { persistResearchedCatalysts } from './catalysts'
import { canonicalCodexSourceUrl, openedPageUrlsFromCodexTranscripts } from './codex-transcript-evidence'
import { type AppEnv } from './env'
import { readInstrumentCatalog } from './instrument-catalog'
import { readInternalWatchlistFocus } from './internal-watchlist'

// Local Codex output is untrusted. Text widths and transcript cardinality bound the validated
// artifact before its exact-page-open evidence is considered; they do not establish provenance.
const FindingSchema = z.object({
  date: z.string(),
  description: z.string().min(1).max(500),
  instrumentName: z.string().min(1).max(512),
  kind: CatalystKindSchema.exclude(['earnings']),
  sourceUrl: z.string().min(1).max(2_048),
  symbol: EquitySymbolSchema,
  timing: z.enum(['pre-market', 'intraday', 'after-hours', 'unknown']),
  title: z.string().min(1).max(160),
})

const ArtifactEnvelopeSchema = z.object({
  codexVersion: z.string().regex(/^codex-cli \d+\.\d+\.\d+$/),
  findings: z.array(z.custom<JsonValue>()),
  model: z.string().min(1).max(160),
  openPageTranscripts: z.array(z.string().max(1_000_000)).min(1).max(MAX_WATCHLIST_SYMBOLS),
  reasoningEffort: z.string().min(1).max(40),
  researchedSymbols: z.array(EquitySymbolSchema).min(1).max(MAX_WATCHLIST_SYMBOLS),
  runId: z.string().uuid(),
})

export type CatalystBootstrapInstrument = {
  assetType: 'equity' | 'etf' | 'index'
  countryOfIncorporation: string | null
  resolutionStatus: 'resolved' | 'unresolved'
  listedMarket: string | null
  name: string
  symbol: string
}

export type CatalystBootstrapValidation = {
  catalysts: Catalyst[]
  model: string
  researchedSymbolCount: number
  runId: string
}

function plusDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

function shortStableHash(value: string): string {
  let hash = 2_166_136_261
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619) >>> 0
  }
  return hash.toString(36)
}

function catalystFromFinding(
  finding: z.infer<typeof FindingSchema>,
  instrument: CatalystBootstrapInstrument,
  accessedUrls: ReadonlySet<string>,
  now: Date,
): Catalyst {
  const today = marketDate(now)
  if (finding.instrumentName !== instrument.name
    || !isValidIsoDate(finding.date)
    || finding.date < today
    || finding.date > plusDays(today, 180)) {
    throw new Error('invalid-instrument-or-date')
  }
  const sourceUrl = canonicalCodexSourceUrl(finding.sourceUrl)
  if (!sourceUrl || !accessedUrls.has(sourceUrl)) throw new Error('invalid-provenance')
  const sourceName = new URL(sourceUrl).hostname.replace(/^www\./, '')
  const identity = `${finding.symbol}:${finding.kind}:${finding.date}:${sourceUrl}:${finding.title}`
  return CatalystSchema.parse({
    confidence: 'estimated',
    date: finding.date,
    description: finding.description,
    id: `${CODEX_WEB_CATALYST_ID_PREFIX}${finding.symbol}:${finding.kind}:${finding.date}:${shortStableHash(identity)}`,
    kind: finding.kind,
    source: `Codex web · ${sourceName}`,
    sourceUrl,
    symbol: finding.symbol,
    timing: finding.timing,
    title: finding.title,
    updatedAt: now.toISOString(),
  })
}

export async function readCatalystBootstrapInstruments(env: AppEnv): Promise<CatalystBootstrapInstrument[]> {
  // This packet is private ops input, but still contains no source category or
  // provenance. It uses the same bounded focus as the live product.
  const orderedSymbols = await readInternalWatchlistFocus(env, [], MAX_WATCHLIST_SYMBOLS)
  const catalog = await readInstrumentCatalog(env, orderedSymbols)
  const missing = orderedSymbols.filter((symbol) => !catalog.has(symbol))
  if (missing.length) throw new Error(`CatalystBootstrap:catalog-incomplete:${missing.length}`)
  return orderedSymbols.map((symbol) => catalogItemForCatalystBootstrap(catalog.get(symbol)!))
}

export function validateCatalystBootstrapArtifact(
  artifactValue: JsonValue,
  instruments: readonly CatalystBootstrapInstrument[],
  now = new Date(),
): CatalystBootstrapValidation {
  const artifact = ArtifactEnvelopeSchema.parse(artifactValue)
  const accessedUrls = openedPageUrlsFromCodexTranscripts(artifact.openPageTranscripts)
  if (artifact.findings.length && !accessedUrls.size) {
    throw new Error('CatalystBootstrap:codex-open-page-evidence-unavailable')
  }
  const researchedSymbols = new Set(artifact.researchedSymbols)
  if (researchedSymbols.size !== artifact.researchedSymbols.length) {
    throw new Error('CatalystBootstrap:duplicate-researched-symbol')
  }
  const known = new Map(instruments.map((instrument) => [instrument.symbol, instrument]))
  for (const symbol of researchedSymbols) {
    if (!known.has(symbol)) throw new Error('CatalystBootstrap:unknown-researched-symbol')
  }
  const accepted = new Map<string, Catalyst>()
  for (const [index, candidate] of artifact.findings.entries()) {
    let finding: z.infer<typeof FindingSchema>
    try {
      finding = FindingSchema.parse(candidate)
    } catch {
      throw new Error(`CatalystBootstrap:invalid-finding:${index}:invalid-shape`)
    }
    const instrument = researchedSymbols.has(finding.symbol) ? known.get(finding.symbol) : undefined
    if (!instrument) throw new Error(`CatalystBootstrap:invalid-finding:${index}:unknown-symbol`)
    let catalyst: Catalyst
    try {
      catalyst = catalystFromFinding(finding, instrument, accessedUrls, now)
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : 'invalid-finding'
      throw new Error(`CatalystBootstrap:invalid-finding:${index}:${reason}`)
    }
    if (accepted.has(catalyst.id)) {
      throw new Error(`CatalystBootstrap:invalid-finding:${index}:duplicate`)
    }
    accepted.set(catalyst.id, catalyst)
  }
  return {
    catalysts: [...accepted.values()],
    model: `${artifact.model}/${artifact.reasoningEffort} (${artifact.codexVersion})`,
    researchedSymbolCount: researchedSymbols.size,
    runId: artifact.runId,
  }
}

async function recordRun(
  env: AppEnv,
  values: {
    accepted?: number
    completedAt?: string
    error?: string
    id: string
    model: string
    rejected?: number
    startedAt: string
    status: 'running' | 'completed' | 'failed'
    symbolCount: number
  },
): Promise<void> {
  if (!env.DB) throw new Error('CatalystBootstrap:store-unavailable')
  await env.DB.prepare(
    `INSERT INTO catalyst_research_runs
      (id, model, status, symbol_count, accepted_count, rejected_count, error_code, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status, accepted_count = excluded.accepted_count,
       rejected_count = excluded.rejected_count, error_code = excluded.error_code,
       completed_at = excluded.completed_at`,
  ).bind(
    values.id, values.model, values.status, values.symbolCount, values.accepted ?? null,
    values.rejected ?? null, values.error ?? null, values.startedAt, values.completedAt ?? null,
  ).run()
}

async function recordFailureReceipt(
  env: AppEnv,
  values: { error: string; id: string; model: string; startedAt: string; symbolCount: number },
): Promise<void> {
  await recordRun(env, { ...values, completedAt: new Date().toISOString(), status: 'failed' })
    .catch((receiptCause) => {
      const receiptError = toError(receiptCause)
      console.error('Catalyst bootstrap failed and its failure receipt could not be recorded', {
        receiptError: receiptError?.name ?? 'UnknownError',
      })
    })
}

export async function applyCatalystBootstrapArtifact(
  env: AppEnv,
  artifactValue: JsonValue,
  now = new Date(),
): Promise<CatalystBootstrapValidation> {
  const instruments = await readCatalystBootstrapInstruments(env)
  const startedAt = now.toISOString()
  // A refused artifact is still a run that happened. Validation runs before any receipt
  // exists, so a gate that rejects every artifact used to leave no trace in D1 at all:
  // the codex-open-page evidence gate refused every run from 2026-08-27 and the table
  // recorded none of them. The envelope parses on its own and carries the run identity,
  // so a rejection can be recorded even when the findings inside it cannot be trusted.
  const envelope = ArtifactEnvelopeSchema.safeParse(artifactValue)
  let validation: CatalystBootstrapValidation
  try {
    validation = validateCatalystBootstrapArtifact(artifactValue, instruments, now)
  } catch (cause) {
    if (envelope.success) {
      await recordFailureReceipt(env, {
        error: cause instanceof Error ? cause.message.slice(0, 160) : 'UnknownError',
        id: envelope.data.runId,
        model: `${envelope.data.model}/${envelope.data.reasoningEffort} (${envelope.data.codexVersion})`,
        startedAt,
        symbolCount: envelope.data.researchedSymbols.length,
      })
    }
    throw cause
  }
  await recordRun(env, {
    id: validation.runId,
    model: validation.model,
    startedAt,
    status: 'running',
    symbolCount: validation.researchedSymbolCount,
  })
  try {
    await persistResearchedCatalysts(env, 'codex-web', validation.catalysts, now)
    await recordRun(env, {
      accepted: validation.catalysts.length,
      completedAt: new Date().toISOString(),
      id: validation.runId,
      model: validation.model,
      rejected: 0,
      startedAt,
      status: 'completed',
      symbolCount: validation.researchedSymbolCount,
    })
    return validation
  } catch (cause) {
    const error = cause instanceof Error ? cause.message.slice(0, 160) : 'UnknownError'
    await recordFailureReceipt(env, {
      error,
      id: validation.runId,
      model: validation.model,
      startedAt,
      symbolCount: validation.researchedSymbolCount,
    })
    throw cause
  }
}

export function catalogItemForCatalystBootstrap(item: InstrumentCatalogItem): CatalystBootstrapInstrument {
  return {
    assetType: item.isIndex ? 'index' : item.isEtf ? 'etf' : 'equity',
    countryOfIncorporation: item.countryOfIncorporation,
    listedMarket: item.listedMarket,
    name: instrumentDisplayName(item),
    resolutionStatus: item.resolutionStatus,
    symbol: item.symbol,
  }
}
