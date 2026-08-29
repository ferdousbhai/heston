import handler from '@tanstack/react-start/server-entry'
import { routeAgentRequest } from 'agents'

import { type AppEnv } from './server/env'
import { authorizePersonalRequest, canonicalHostRedirect } from './server/http'
import { shouldRunDailyResearch } from './server/research'
import {
  INSTRUMENT_CATALOG_CRON,
  runDailyInstrumentCatalogRefresh,
  startScheduledJob,
} from './server/scheduled-jobs'

export { DanAgent } from './server/dan-agent'
export { BrokerGate } from './server/broker-gate'
export { MarketFeed } from './server/market-feed'
export { DailyResearchWorkflow } from './server/daily-research-workflow'

export default {
  async fetch(request: Request, env: AppEnv) {
    const canonicalRedirect = canonicalHostRedirect(request)
    if (canonicalRedirect) return canonicalRedirect
    if (new URL(request.url).pathname.startsWith('/agents/')) {
      const unauthorized = await authorizePersonalRequest(request, env, true)
      if (unauthorized) return unauthorized
      const agentResponse = await routeAgentRequest(request, env)
      return agentResponse ?? new Response('Agent not found', { status: 404 })
    }
    return handler.fetch(request)
  },
  scheduled(controller: ScheduledController, env: AppEnv, context: ExecutionContext) {
    const scheduledAt = new Date(controller.scheduledTime)
    const tasks: Promise<unknown>[] = []
    if (controller.cron === INSTRUMENT_CATALOG_CRON) {
      tasks.push(runDailyInstrumentCatalogRefresh(env, scheduledAt))
    }
    if (shouldRunDailyResearch(scheduledAt)) {
      tasks.push(startScheduledJob(env, 'daily-research', scheduledAt))
    }
    if (tasks.length) context.waitUntil(Promise.all(tasks).then(() => undefined))
  },
}
