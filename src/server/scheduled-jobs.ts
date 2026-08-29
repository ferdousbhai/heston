import { marketDate } from '../domain/catalyst'
import { type AppEnv } from './env'
import { researchBriefId } from './research-contracts'
import { refreshInternalInstrumentCatalogFromTastytrade } from './tastytrade'

export type ScheduledJobKind = 'daily-research'

export const SCHEDULED_JOB_KINDS = ['daily-research'] as const
export const INSTRUMENT_CATALOG_CRON = '0 12 * * *'

/** Idempotent daily projection refresh. D1 row timestamps are its durable receipt. */
export async function runDailyInstrumentCatalogRefresh(env: AppEnv, now = new Date()): Promise<void> {
  const result = await refreshInternalInstrumentCatalogFromTastytrade(env, now)
  console.info(JSON.stringify({
    event: 'InstrumentCatalogRefreshed',
    missingCount: result.missingSymbols.length,
    receivedCount: result.receivedCount,
    requestedCount: result.requestedCount,
  }))
}

export async function startScheduledJob(
  env: AppEnv,
  kind: ScheduledJobKind,
  scheduledAt = new Date(),
): Promise<string> {
  if (kind !== 'daily-research' || !env.DAILY_RESEARCH_WORKFLOW) {
    throw new Error('DailyResearchWorkflowUnavailable')
  }
  const instance = await env.DAILY_RESEARCH_WORKFLOW.create({
    id: researchBriefId(marketDate(scheduledAt)),
    params: { persist: true, requireMarketOpen: true, scheduledAt: scheduledAt.toISOString() },
  })
  return instance.id
}
