import { toError } from '../domain/failure'
import { newYorkClock } from '../domain/market-clock'
import { type AppEnv } from './env'
import { generateDailyResearch } from './research'
import { runXCatalystResearch } from './x-catalysts'

export type ScheduledJobKind = 'daily-research' | 'x-catalysts'

export const SCHEDULED_JOB_KINDS = ['daily-research', 'x-catalysts'] as const

function errorCode(error: Error | undefined): string {
  if (!error) return 'UnknownError'
  return `${error.name}:${error.message}`.replaceAll(/[^A-Za-z0-9:._-]/g, '_').slice(0, 160)
}

/** Durable per-NYC-day claim plus status recording. Failures rethrow so Cron Trigger history is truthful. */
export async function runScheduledJob(
  env: AppEnv,
  kind: ScheduledJobKind,
  scheduledAt: Date,
  task: () => Promise<void>,
): Promise<'completed' | 'skipped'> {
  if (!env.DB) throw new Error('ScheduledJobStoreUnavailable')
  const clock = newYorkClock(scheduledAt)
  const id = `${kind}:${clock.localDate}`
  const startedAt = new Date().toISOString()
  const staleBefore = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
  const claim = await env.DB.prepare(
    `INSERT INTO scheduled_runs
       (id, kind, market_date, status, error_code, scheduled_at, started_at, completed_at)
     VALUES (?, ?, ?, 'running', NULL, ?, ?, NULL)
     ON CONFLICT(id) DO UPDATE SET
       status = 'running', error_code = NULL, scheduled_at = excluded.scheduled_at,
       started_at = excluded.started_at, completed_at = NULL
     WHERE scheduled_runs.status = 'failed'
        OR (scheduled_runs.status = 'running' AND scheduled_runs.started_at <= ?)`,
  ).bind(id, kind, clock.localDate, scheduledAt.toISOString(), startedAt, staleBefore).run()
  if (claim.meta.changes !== 1) return 'skipped'
  try {
    await task()
    const completed = await env.DB.prepare(
      "UPDATE scheduled_runs SET status = 'completed', completed_at = ?, error_code = NULL WHERE id = ? AND status = 'running'",
    ).bind(new Date().toISOString(), id).run()
    if (completed.meta.changes !== 1) throw new Error('ScheduledJobReceiptNotRecorded')
    return 'completed'
  } catch (error) {
    const code = errorCode(toError(error))
    await env.DB.prepare(
      "UPDATE scheduled_runs SET status = 'failed', completed_at = ?, error_code = ? WHERE id = ? AND status = 'running'",
    ).bind(new Date().toISOString(), code, id).run().catch(() => undefined)
    console.error(JSON.stringify({ event: 'ScheduledJobFailed', id, kind, error: code }))
    throw error
  }
}

/** One dispatch boundary shared by Cron and the owner-only run-now endpoint. */
export function runScheduledJobKind(
  env: AppEnv,
  kind: ScheduledJobKind,
  scheduledAt = new Date(),
): Promise<'completed' | 'skipped'> {
  return runScheduledJob(env, kind, scheduledAt, async () => {
    if (kind === 'daily-research') await generateDailyResearch(env, scheduledAt)
    else await runXCatalystResearch(env, scheduledAt)
  })
}
