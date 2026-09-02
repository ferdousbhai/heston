import { marketDate } from '../domain/catalyst'
import { readMarketStatus } from './brokerage-read-tools'
import { type AppEnv } from './env'
import { dailyRecommendationsId } from './research-contracts'
import { readBoundSecret, readStoredSecret } from './secrets'
import { sendTelegramMessage } from './telegram'

/*
 * The research run now happens on a machine this Worker cannot see, so the Worker watches
 * the one thing it can: whether today's brief exists by late morning New York. A missing
 * brief on an open market day is the runner's laptop asleep, its network filtered, or its
 * agent stuck — all invisible from here except as absence.
 *
 * The alert goes to the owner's private chat, never the public channel: a failed internal
 * run is operations, not publication. Without an owner chat id configured the alert still
 * fails loudly in the Worker logs rather than silently succeeding at nothing.
 */

export type DailyBriefWatchdogResult = 'alerted' | 'market-closed' | 'published' | 'unalertable'

export async function watchDailyBrief(
  env: AppEnv,
  now: Date,
  fetcher: typeof fetch = fetch,
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
  console.error(JSON.stringify({ event: 'DailyBriefMissing', id }))
  if (!env.TELEGRAM_OWNER_CHAT_ID) return 'unalertable'
  const configuration = {
    botToken: readBoundSecret(env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN'),
    chatId: await readStoredSecret(env.TELEGRAM_OWNER_CHAT_ID, 'TELEGRAM_OWNER_CHAT_ID'),
  }
  await sendTelegramMessage(configuration, {
    html: `<b>Spice: no daily brief for ${marketDate(now)}.</b> The local research run has not published; check the runner.`,
  }, fetcher)
  return 'alerted'
}
