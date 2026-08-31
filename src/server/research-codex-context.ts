import { CatalystSchema, marketDate, type Catalyst } from '../domain/catalyst'
import { toError } from '../domain/failure'
import { type AppEnv } from './env'
import { CATALYST_HORIZON_DAYS } from '../domain/catalyst'
import { addDays } from '../domain/iso-date'

const CODEX_WEB_EVIDENCE_MAX_AGE_DAYS = 7
// The nearest-dated forty rows keep this complementary packet well below the
// Workflow step-output budget while giving each watched name room for several events.
const CODEX_WEB_EVIDENCE_MAX_ROWS = 40

export type CodexResearchContext = {
  catalysts: Catalyst[]
  fetchedAt: string
  freshSince: string
  source: 'codex-web'
  status: 'available'
  truncated: boolean
} | {
  errorName: string
  fetchedAt: string
  source: 'codex-web'
  status: 'unavailable'
}

function freshSince(now: Date): string {
  const cutoff = new Date(now)
  cutoff.setUTCDate(cutoff.getUTCDate() - CODEX_WEB_EVIDENCE_MAX_AGE_DAYS)
  return cutoff.toISOString()
}

/**
 * The laptop run is complementary: an absent binding, missing run, or failed read
 * becomes explicit unavailable context and never takes down required Reddit/X research.
 * Rows qualify only by their last verification time, not their older update timestamp.
 */
export async function readCodexResearchContext(
  env: AppEnv,
  now = new Date(),
): Promise<CodexResearchContext> {
  const fetchedAt = now.toISOString()
  if (!env.DB) {
    return { errorName: 'DatabaseBindingUnavailable', fetchedAt, source: 'codex-web', status: 'unavailable' }
  }
  const cutoff = freshSince(now)
  const today = marketDate(now)
  try {
    const result = await env.DB.prepare(
      `SELECT id, symbol, kind, title, description, event_date AS date, timing, confidence,
        source_label AS source, source_url AS "sourceUrl", updated_at AS "updatedAt"
       FROM catalysts
       WHERE source_provider = 'codex-web' AND last_seen_at >= ? AND event_date BETWEEN ? AND ?
       ORDER BY event_date ASC, symbol ASC, id ASC
       LIMIT ?`,
    ).bind(
      cutoff,
      today,
      addDays(today, CATALYST_HORIZON_DAYS),
      CODEX_WEB_EVIDENCE_MAX_ROWS + 1,
    ).all()
    const rows = CatalystSchema.array().parse(result.results ?? [])
    return {
      catalysts: rows.slice(0, CODEX_WEB_EVIDENCE_MAX_ROWS),
      fetchedAt,
      freshSince: cutoff,
      source: 'codex-web',
      status: 'available',
      truncated: rows.length > CODEX_WEB_EVIDENCE_MAX_ROWS,
    }
  } catch (cause) {
    const error = toError(cause)
    const context = {
      errorName: error?.name ?? 'UnknownError',
      fetchedAt,
      source: 'codex-web' as const,
      status: 'unavailable' as const,
    }
    console.error(JSON.stringify({ event: 'DailyResearchCodexContextUnavailable', ...context }))
    return context
  }
}
