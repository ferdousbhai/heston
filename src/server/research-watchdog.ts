import { marketDate } from '../domain/catalyst'
import { readMarketStatus } from './brokerage-read-tools'
import { type AppEnv } from './env'
import { dailyRecommendationsId } from './research-contracts'

/*
 * The research run now happens on a machine this Worker cannot see, so the Worker watches
 * the one thing it can: whether today's brief exists by late morning New York. A missing
 * brief on an open market day is the runner's laptop asleep, its network filtered, or its
 * agent stuck — all invisible from here except as absence.
 *
 * It records, it does not notify. The runner writes its own outcome to a local log
 * (the run script in the private `spice-research` repository, `~/.local/state/spice/research-run.log`), which is where the
 * reason lives; this is the second opinion for the case that log cannot cover, because a
 * machine that never woke writes nothing. `DailyBriefMissing` in the Worker logs is the
 * record. There is deliberately no push channel: the one that existed alerted a chat id that
 * was never configured, so it had only ever returned 'unalertable'.
 */

export type DailyBriefWatchdogResult = 'market-closed' | 'missing' | 'published'

export async function watchDailyBrief(
  env: AppEnv,
  now: Date,
): Promise<DailyBriefWatchdogResult> {
  if (!env.DB) throw new Error('DailyBriefWatchdogPersistenceUnavailable')
  const id = dailyRecommendationsId(marketDate(now))
  const row = await env.DB.prepare('SELECT id FROM daily_recommendations WHERE id = ?')
    .bind(id)
    .first()
  if (row) return 'published'
  // A market holiday falls on the weekday cron but owes no brief; the broker's session state
  // at late morning New York separates it from a trading day whose run failed.
  const status = await readMarketStatus(env, now)
  if (status.state.toLowerCase() !== 'open') {
    console.info(JSON.stringify({ event: 'DailyBriefWatchdogMarketClosed', id, state: status.state }))
    return 'market-closed'
  }
  console.error(JSON.stringify({ event: 'DailyBriefMissing', id, marketDate: marketDate(now) }))
  return 'missing'
}
