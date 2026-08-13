import handler from '@tanstack/react-start/server-entry'

import { type AppEnv } from './server/env'
import { generateDailyResearch, shouldRunDailyResearch } from './server/research'

export default {
  fetch(request: Request) {
    return handler.fetch(request)
  },
  scheduled(controller: ScheduledController, env: AppEnv, context: ExecutionContext) {
    const scheduledAt = new Date(controller.scheduledTime)
    if (!shouldRunDailyResearch(scheduledAt)) return
    context.waitUntil(generateDailyResearch(env, scheduledAt).then(() => undefined).catch((error: unknown) => {
      console.error('DailyResearchFailed', error instanceof Error ? error.message : 'UnknownError')
    }))
  },
}
