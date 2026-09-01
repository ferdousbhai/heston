import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { z } from 'zod'

import { generateDailyRecommendations } from './research'
import { type AppEnv, type DailyResearchWorkflowParams } from './env'
import { publishDailyRecommendationsToTelegram } from './recommendation-telegram-publication'

const DailyResearchWorkflowParameters = z.object({
  persist: z.boolean(),
  requireMarketOpen: z.boolean(),
  scheduledAt: z.string().datetime(),
})

export class DailyResearchWorkflow extends WorkflowEntrypoint<AppEnv, DailyResearchWorkflowParams> {
  async run(event: Readonly<WorkflowEvent<DailyResearchWorkflowParams>>, step: WorkflowStep) {
    const params = DailyResearchWorkflowParameters.parse(event.payload)
    const now = new Date(params.scheduledAt)
    let call = 0
    const runStep = <T>(name: string, task: () => Promise<T>): Promise<T> => {
      const execute = async () => {
        const result = await task()
        // SAFETY: every runStep caller returns JSON-compatible provider, broker, or D1 data.
        return result as never
      }
      const result = step.do(
        `${++call}-${name}`,
        // Refusing retries was defending the wrong thing: a step that succeeded is never
        // re-run, so a retry only ever follows a failure, where nothing was accepted and
        // nothing was paid for twice on purpose. The engine reports its own transient faults
        // as an opaque internal error, and one of those was enough to discard nine turns of
        // paid research and the day's output. The original failure still reaches the AI
        // Gateway log either way, and a deterministic failure simply fails three times.
        { retries: { backoff: 'exponential', delay: '10 seconds', limit: 2 } },
        execute,
      )
      // SAFETY: Workflow replay preserves the exact value returned by this generic task.
      return result as Promise<T>
    }
    const dailyRecommendations = await generateDailyRecommendations(this.env, now, {
      persist: params.persist,
      requireMarketOpen: params.requireMarketOpen,
      runStep,
    })
    // Previews are deliberately non-publishing. Production recommendations reach the
    // channel only after its public D1 record has committed successfully.
    const telegramMessageCount = params.persist
      ? await runStep(
        'publish-telegram',
        () => publishDailyRecommendationsToTelegram(this.env, dailyRecommendations),
      )
      : 0
    return {
      dailyRecommendationsId: dailyRecommendations.id,
      recommendationCount: dailyRecommendations.recommendations.length,
      publishedAt: dailyRecommendations.publishedAt,
      linkCount: dailyRecommendations.links.length,
      telegramMessageCount,
    }
  }
}
