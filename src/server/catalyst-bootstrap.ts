import { z } from 'zod'

import { CATALYST_HORIZON_DAYS, CatalystKindSchema, CatalystSchema, CODEX_WEB_CATALYST_ID_PREFIX, marketDate, type Catalyst } from '../domain/catalyst'
import { toError } from '../domain/failure'
import { EquitySymbolSchema, instrumentDisplayName, type InstrumentCatalogItem } from '../domain/instrument'
import { addDays, isValidIsoDate, textMentionsIsoDate } from '../domain/iso-date'
import { type JsonValue } from '../domain/json-payload'
import { MAX_WATCHLIST_SYMBOLS } from '../domain/watchlist'
import { persistResearchedCatalysts } from './catalysts'
import { canonicalCodexSourceUrl } from './codex-source-url'
import { type AppEnv } from './env'
import { readInstrumentCatalog } from './instrument-catalog'
import { readInternalWatchlistFocus } from './internal-watchlist'

// Local Codex output is untrusted. Text widths bound the validated artifact before its
// provenance is considered; they do not establish it. Provenance is the verification block:
// the ops runner fetched the cited URL itself and recorded where the bytes came from and the
// text around the date, and this boundary re-checks that text rather than trusting the claim.
const VerificationSchema = z.object({
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  // Recorded for audit, not enforced: laptop and edge clocks disagree by unknown amounts,
  // so a freshness bound here would reject honest runs without stopping a dishonest one.
  fetchedAt: z.string().datetime(),
  finalUrl: z.string().min(1).max(2_048),
  httpStatus: z.literal(200),
  snippet: z.string().min(1).max(400),
  // Which client read the page. A proxy fetch is a third party reporting what the URL
  // served rather than the runner reading it, which is weaker evidence and is recorded as
  // such rather than being flattened into the others.
  via: z.enum(['fetch', 'browser', 'proxy']),
})

const FindingSchema = z.object({
  date: z.string(),
  description: z.string().min(1).max(500),
  instrumentName: z.string().min(1).max(512),
  kind: CatalystKindSchema.exclude(['earnings']),
  sourceUrl: z.string().min(1).max(2_048),
  symbol: EquitySymbolSchema,
  timing: z.enum(['pre-market', 'intraday', 'after-hours', 'unknown']),
  title: z.string().min(1).max(160),
  verification: VerificationSchema,
})

const ArtifactEnvelopeSchema = z.object({
  codexVersion: z.string().regex(/^codex-cli \d+\.\d+\.\d+$/),
  findings: z.array(z.custom<JsonValue>()),
  model: z.string().min(1).max(160),
  reasoningEffort: z.string().min(1).max(40),
  // What the runner fetched and refused, so a run that verifies nothing is visible as a
  // recorded rejection count rather than as an empty success.
  rejectedCount: z.number().int().nonnegative().max(1_000),
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
  rejectedCount: number
  rejections: string[]
  researchedSymbolCount: number
  runId: string
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
  now: Date,
): Catalyst {
  const today = marketDate(now)
  if (finding.instrumentName !== instrument.name
    || !isValidIsoDate(finding.date)
    || finding.date < today
    || finding.date > addDays(today, CATALYST_HORIZON_DAYS)) {
    throw new Error('invalid-instrument-or-date')
  }
  // Identity and label come from where the bytes actually arrived from rather than from the
  // URL the model cited, so an open redirect cannot make a respectable host vouch for a page
  // served elsewhere. The cited URL still has to clear the same policy: a social source that
  // redirects somewhere acceptable is still a social source.
  if (!canonicalCodexSourceUrl(finding.sourceUrl)) throw new Error('invalid-provenance')
  const sourceUrl = canonicalCodexSourceUrl(finding.verification.finalUrl)
  if (!sourceUrl) throw new Error('invalid-provenance')
  // The runner already matched the date to decide the finding was worth sending; matching it
  // again here is what keeps this boundary checking evidence instead of accepting a verdict.
  if (!textMentionsIsoDate(finding.verification.snippet, finding.date)) {
    throw new Error('unverified-date')
  }
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
  const researchedSymbols = new Set(artifact.researchedSymbols)
  if (researchedSymbols.size !== artifact.researchedSymbols.length) {
    throw new Error('CatalystBootstrap:duplicate-researched-symbol')
  }
  const known = new Map(instruments.map((instrument) => [instrument.symbol, instrument]))
  for (const symbol of researchedSymbols) {
    if (!known.has(symbol)) throw new Error('CatalystBootstrap:unknown-researched-symbol')
  }
  // Two different failures live here. An artifact that breaks its own contract — an
  // unreadable envelope, a researched-symbol list that disagrees with the watchlist, a
  // finding that is not even the right shape — says the producer is wrong and none of it can
  // be trusted, so the whole artifact goes. A single finding that fails its own date,
  // instrument or provenance check says only that one citation did not hold up; it is
  // dropped and counted, because condemning ninety-nine verified siblings over it loses a
  // day of research to one bad row on a feed the product treats as best effort.
  const accepted = new Map<string, Catalyst>()
  const rejections: string[] = []
  for (const [index, candidate] of artifact.findings.entries()) {
    let finding: z.infer<typeof FindingSchema>
    try {
      finding = FindingSchema.parse(candidate)
    } catch {
      throw new Error(`CatalystBootstrap:invalid-finding:${index}:invalid-shape`)
    }
    const instrument = researchedSymbols.has(finding.symbol) ? known.get(finding.symbol) : undefined
    if (!instrument) {
      rejections.push(`${index}:unknown-symbol`)
      continue
    }
    let catalyst: Catalyst
    try {
      catalyst = catalystFromFinding(finding, instrument, now)
    } catch (cause) {
      rejections.push(`${index}:${cause instanceof Error ? cause.message : 'invalid-finding'}`)
      continue
    }
    if (accepted.has(catalyst.id)) {
      rejections.push(`${index}:duplicate`)
      continue
    }
    accepted.set(catalyst.id, catalyst)
  }
  return {
    catalysts: [...accepted.values()],
    model: `${artifact.model}/${artifact.reasoningEffort} (${artifact.codexVersion})`,
    // What the runner could not verify plus what this boundary refused, so the receipt
    // counts every finding that did not reach D1 rather than only the runner's share.
    rejectedCount: artifact.rejectedCount + rejections.length,
    rejections,
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
      rejected: validation.rejectedCount,
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
