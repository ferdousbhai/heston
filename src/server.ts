import handler from '@tanstack/react-start/server-entry'

import { type AppEnv } from './server/env'
import { canonicalHostRedirect, finalizeDocumentResponse } from './server/http'
import { handleMcpRequest, mcpEndpointRedirect } from './server/mcp'
import { watchDailyBrief } from './server/research-watchdog'
import { refreshYearCandles } from './server/scheduled-jobs'
import { configureTypeboxRuntime } from './server/typebox-runtime'

configureTypeboxRuntime()

export { BrokerGate } from './server/broker-gate'
export { MarketFeed } from './server/market-feed'

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext) {
    const canonicalRedirect = canonicalHostRedirect(request)
    if (canonicalRedirect) return canonicalRedirect
    // The tool surface for the agent on the owner's machine. Bearer-authed inside the
    // handler; the session/cookie path stays untouched and the token opens nothing else.
    if (new URL(request.url).pathname === '/mcp') return handleMcpRequest(request, env, ctx)
    // An agent aimed at the site rather than at `/mcp` would otherwise be handed the web app's
    // HTML with a 200 and fail inside its JSON parser, saying nothing useful to anyone.
    const misdirected = await mcpEndpointRedirect(request)
    if (misdirected) return misdirected
    return finalizeDocumentResponse(request, await handler.fetch(request))
  },
  scheduled(controller: ScheduledController, env: AppEnv, context: ExecutionContext) {
    const scheduledAt = new Date(controller.scheduledTime)
    // Late-morning New York: the local research run should have published by now, and this
    // Worker's only view of that machine is whether today's brief exists.
    if (controller.cron === '30 15 * * 1-5') {
      context.waitUntil(watchDailyBrief(env, scheduledAt)
        .then((result) => console.info(JSON.stringify({ event: 'DailyBriefWatchdog', result })))
        .catch((cause: unknown) => console.error(
          'DailyBriefWatchdogFailed',
          cause instanceof Error ? cause.name : 'UnknownError',
        )))
      return
    }
    // The year chart is decoration over live prices, so a failed refresh leaves the last good
    // series in place rather than failing the tick that also starts research. Record the
    // degraded run without logging symbols or provider content.
    context.waitUntil(refreshYearCandles(env, scheduledAt)
      .then((symbolCount) => console.info(JSON.stringify({
        event: 'YearCandlesRefreshed',
        symbolCount,
      })))
      .catch((cause: unknown) => console.error(
        'YearCandleRefreshFailed',
        cause instanceof Error ? cause.name : 'UnknownError',
      )))
  },
}
