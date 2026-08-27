import { z } from 'zod'

import { CatalystKindSchema, CatalystSchema, isValidIsoDate, marketDate, type Catalyst } from '../domain/catalyst'
import { EquitySymbolSchema, instrumentDisplayName, type InstrumentCatalogItem } from '../domain/instrument'
import { type JsonValue } from '../domain/json-payload'
import { persistResearchedCatalysts } from './catalysts'
import { canonicalCodexSourceUrl, openedPageUrlsFromCodexTranscripts } from './codex-transcript-evidence'
import { type AppEnv } from './env'
import { readInstrumentCatalog } from './instrument-catalog'
import { readInternalWatchlistFocus } from './internal-watchlist'

const MODEL = 'local-codex-native-web'
const MAX_FINDINGS = 1_000
const FindingSchema = z.object({
  date: z.string(),
  description: z.string().trim().min(1).max(500),
  instrumentName: z.string().trim().min(1).max(512),
  kind: CatalystKindSchema.exclude(['earnings']),
  sourceUrl: z.string().trim().max(2_048),
  symbol: EquitySymbolSchema,
  timing: z.enum(['pre-market', 'intraday', 'after-hours', 'unknown']),
  title: z.string().trim().min(1).max(160),
})

const ArtifactEnvelopeSchema = z.object({
  findings: z.array(z.custom<JsonValue>()).max(MAX_FINDINGS),
  generatedAt: z.string().datetime(),
  researchedSymbols: z.array(EquitySymbolSchema).min(1).max(10_000),
  runId: z.string().uuid(),
  transcripts: z.array(z.string().max(1_000_000)).min(1).max(100),
})

export type CatalystBootstrapInstrument = {
  assetType: 'equity' | 'etf' | 'index'
  countryOfIncorporation: string | null
  description: string | null
  instrumentSubType: string | null
  resolutionStatus: 'resolved' | 'unresolved'
  listedMarket: string | null
  name: string
  shortDescription: string | null
  symbol: string
  underlyingProductType: string | null
}

export type CatalystBootstrapValidation = {
  catalysts: Catalyst[]
  rejected: Array<{ index: number; reason: string }>
  researchedSymbolCount: number
  runId: string
}

function plusDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

function cleanText(value: string): string {
  return value.replaceAll('—', '-').replaceAll(/\s+/g, ' ').trim()
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
): Catalyst | undefined {
  const today = marketDate(now)
  if (finding.instrumentName !== instrument.name
    || !isValidIsoDate(finding.date)
    || finding.date < today
    || finding.date > plusDays(today, 180)) return undefined
  const sourceUrl = canonicalCodexSourceUrl(finding.sourceUrl)
  if (!sourceUrl || !accessedUrls.has(sourceUrl)) return undefined
  const title = cleanText(finding.title)
  const description = cleanText(finding.description)
  const sourceName = new URL(sourceUrl).hostname.replace(/^www\./, '')
  const identity = `${finding.symbol}:${finding.kind}:${finding.date}:${sourceUrl}:${title}`
  return CatalystSchema.parse({
    confidence: 'estimated',
    date: finding.date,
    description,
    id: `codex-web:${finding.symbol}:${finding.kind}:${finding.date}:${shortStableHash(identity)}`,
    kind: finding.kind,
    source: `Codex web · ${sourceName}`,
    sourceUrl,
    symbol: finding.symbol,
    timing: finding.timing,
    title,
    updatedAt: now.toISOString(),
  })
}

export async function readCatalystBootstrapInstruments(env: AppEnv): Promise<CatalystBootstrapInstrument[]> {
  // This packet is private ops input, but still contains no source category or
  // provenance. It uses the same bounded focus as the live product.
  const orderedSymbols = await readInternalWatchlistFocus(env, [], 100)
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
  const accessedUrls = openedPageUrlsFromCodexTranscripts(artifact.transcripts)
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
  const allowed = new Map([...known].filter(([symbol]) => researchedSymbols.has(symbol)))
  const accepted = new Map<string, Catalyst>()
  const rejected: CatalystBootstrapValidation['rejected'] = []
  for (const [index, candidate] of artifact.findings.entries()) {
    const finding = FindingSchema.safeParse(candidate)
    if (!finding.success) {
      rejected.push({ index, reason: 'invalid-shape' })
      continue
    }
    const instrument = allowed.get(finding.data.symbol)
    const catalyst = instrument ? catalystFromFinding(finding.data, instrument, accessedUrls, now) : undefined
    if (!catalyst) {
      rejected.push({ index, reason: 'invalid-provenance-or-date' })
      continue
    }
    if (accepted.has(catalyst.id)) {
      rejected.push({ index, reason: 'duplicate' })
      continue
    }
    accepted.set(catalyst.id, catalyst)
  }
  return {
    catalysts: [...accepted.values()],
    rejected,
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
    values.id, MODEL, values.status, values.symbolCount, values.accepted ?? null,
    values.rejected ?? null, values.error ?? null, values.startedAt, values.completedAt ?? null,
  ).run()
}

export async function applyCatalystBootstrapArtifact(
  env: AppEnv,
  artifactValue: JsonValue,
  now = new Date(),
): Promise<CatalystBootstrapValidation> {
  const instruments = await readCatalystBootstrapInstruments(env)
  const validation = validateCatalystBootstrapArtifact(artifactValue, instruments, now)
  const startedAt = now.toISOString()
  await recordRun(env, {
    id: validation.runId,
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
      rejected: validation.rejected.length,
      startedAt,
      status: 'completed',
      symbolCount: validation.researchedSymbolCount,
    })
    return validation
  } catch (cause) {
    const error = cause instanceof Error ? cause.message.slice(0, 160) : 'UnknownError'
    await recordRun(env, {
      completedAt: new Date().toISOString(),
      error,
      id: validation.runId,
      startedAt,
      status: 'failed',
      symbolCount: validation.researchedSymbolCount,
    }).catch(() => undefined)
    throw cause
  }
}

export function catalogItemForCatalystBootstrap(item: InstrumentCatalogItem): CatalystBootstrapInstrument {
  return {
    assetType: item.isIndex ? 'index' : item.isEtf ? 'etf' : 'equity',
    countryOfIncorporation: item.countryOfIncorporation,
    description: item.description,
    instrumentSubType: item.instrumentSubType,
    listedMarket: item.listedMarket,
    name: instrumentDisplayName(item),
    resolutionStatus: item.resolutionStatus,
    shortDescription: item.shortDescription,
    symbol: item.symbol,
    underlyingProductType: item.underlyingProductType,
  }
}
