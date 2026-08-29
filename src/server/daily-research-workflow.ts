import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import { z } from 'zod'

import { generateDailyResearch } from './research'
import { type AppEnv, type DailyResearchWorkflowParams } from './env'

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
        // A repeated model or provider turn is a different research run. Keep the
        // original failure for AI Gateway inspection instead of silently paying for
        // and accepting a second answer.
        { retries: { delay: 0, limit: 0 } },
        execute,
      )
      // SAFETY: Workflow replay preserves the exact value returned by this generic task.
      return result as Promise<T>
    }
    const brief = await generateDailyResearch(this.env, now, {
      persist: params.persist,
      requireMarketOpen: params.requireMarketOpen,
      runStep,
    })
    return {
      briefId: brief.id,
      ideaCount: brief.ideas.length,
      publishedAt: brief.publishedAt,
      readingCount: brief.readingList.length,
    }
  }
}
