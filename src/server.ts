import handler from '@tanstack/react-start/server-entry'
import { routeAgentRequest } from 'agents'

import { SPICE_DEPLOYMENT_ID } from './deployment'
import { SPICE_DEPLOYMENT_ID_HEADER } from './domain/deployment'
import { type AppEnv } from './server/env'
import { authorizePersonalRequest, canonicalHostRedirect } from './server/http'
import { shouldStartScheduledResearch } from './server/research'
import { handleMcpRequest } from './server/mcp'
import { refreshYearCandles, startScheduledJob } from './server/scheduled-jobs'
import { configureTypeboxRuntime } from './server/typebox-runtime'

configureTypeboxRuntime()

export { DanAgent } from './server/dan-agent'
export { BrokerGate } from './server/broker-gate'
export { MarketFeed } from './server/market-feed'
export { DailyResearchWorkflow } from './server/daily-research-workflow'

export default {
  async fetch(request: Request, env: AppEnv, ctx: ExecutionContext) {
    const canonicalRedirect = canonicalHostRedirect(request)
    if (canonicalRedirect) return canonicalRedirect
    // The tool surface for the agent on the owner's machine. Bearer-authed inside the
    // handler; the session/cookie path stays untouched and the token opens nothing else.
    if (new URL(request.url).pathname === '/mcp') return handleMcpRequest(request, env, ctx)
    if (new URL(request.url).pathname.startsWith('/agents/')) {
      const unauthorized = await authorizePersonalRequest(request, env, true)
      if (unauthorized) return unauthorized
      const agentResponse = await routeAgentRequest(request, env)
      return agentResponse ?? new Response('Agent not found', { status: 404 })
    }
    const response = await handler.fetch(request)
    // The shell names the hashed bundles for one deployment, so a cached copy pins a browser
    // to code that no longer exists. It carries no validators either, so a revalidating fetch
    // is a plain refetch of a small document. Hashed assets stay immutable via `_headers`.
    if (!response.headers.get('content-type')?.includes('text/html')) return response
    const headers = new Headers(response.headers)
    headers.set('Cache-Control', 'no-cache')
    headers.set(SPICE_DEPLOYMENT_ID_HEADER, SPICE_DEPLOYMENT_ID)
    return new Response(response.body, { headers, status: response.status, statusText: response.statusText })
  },
  scheduled(controller: ScheduledController, env: AppEnv, context: ExecutionContext) {
    const scheduledAt = new Date(controller.scheduledTime)
    if (shouldStartScheduledResearch(scheduledAt)) {
      context.waitUntil(startScheduledJob(env, 'daily-research', scheduledAt).then(() => undefined))
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
