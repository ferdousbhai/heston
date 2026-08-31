import handler from '@tanstack/react-start/server-entry'
import { routeAgentRequest } from 'agents'

import { type AppEnv } from './server/env'
import { authorizePersonalRequest, canonicalHostRedirect } from './server/http'
import { shouldStartScheduledResearch } from './server/research'
import { startScheduledJob } from './server/scheduled-jobs'
import { configureTypeboxRuntime } from './server/typebox-runtime'

configureTypeboxRuntime()

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
    if (shouldStartScheduledResearch(scheduledAt)) {
      context.waitUntil(startScheduledJob(env, 'daily-research', scheduledAt).then(() => undefined))
    }
  },
}
