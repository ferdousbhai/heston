import handler from '@tanstack/react-start/server-entry'

import { type AppEnv } from './server/env'
import { generateDailyResearch, shouldRunDailyResearch } from './server/research'
import { runXCatalystResearch, shouldRunXCatalystResearch } from './server/x-catalysts'

export { MarketFeed } from './server/market-feed'

export default {
  fetch(request: Request) {
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
