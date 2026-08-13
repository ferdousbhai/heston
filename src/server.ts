import handler from '@tanstack/react-start/server-entry'
import { routeAgentRequest } from 'agents'

import { type AppEnv } from './server/env'
import { authorizePersonalRequest } from './server/http'
import { generateDailyResearch, shouldRunDailyResearch } from './server/research'
import { runXCatalystResearch, shouldRunXCatalystResearch } from './server/x-catalysts'

export { DanAgent } from './server/dan-agent'
export { MarketFeed } from './server/market-feed'

export default {
  async fetch(request: Request, env: AppEnv) {
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
    if (shouldRunDailyResearch(scheduledAt)) tasks.push(generateDailyResearch(env, scheduledAt).catch((error: unknown) => {
      console.error('DailyResearchFailed', error instanceof Error ? error.message : 'UnknownError')
    }))
    if (shouldRunXCatalystResearch(scheduledAt)) tasks.push(runXCatalystResearch(env, scheduledAt).catch((error: unknown) => {
      console.error('XCatalystResearchFailed', error instanceof Error ? error.message : 'UnknownError')
    }))
    if (tasks.length) context.waitUntil(Promise.all(tasks).then(() => undefined))
  },
}
