import { marketDate } from '../domain/catalyst'
import { type AppEnv } from './env'
import { researchBriefId } from './research-contracts'

export type ScheduledJobKind = 'daily-research'

export const SCHEDULED_JOB_KINDS = ['daily-research'] as const

export async function startDailyResearchWorkflow(
  env: AppEnv,
  params: { persist: boolean; requireMarketOpen: boolean; scheduledAt: string },
  id: string = crypto.randomUUID(),
): Promise<string> {
  if (!env.DAILY_RESEARCH_WORKFLOW) throw new Error('DailyResearchWorkflowUnavailable')
  const instance = await env.DAILY_RESEARCH_WORKFLOW.create({ id, params })
  return instance.id
}

export async function startScheduledJob(
  env: AppEnv,
  kind: ScheduledJobKind,
  scheduledAt = new Date(),
): Promise<string> {
  if (kind !== 'daily-research') throw new Error('DailyResearchWorkflowUnavailable')
  return startDailyResearchWorkflow(
    env,
    { persist: true, requireMarketOpen: true, scheduledAt: scheduledAt.toISOString() },
    researchBriefId(marketDate(scheduledAt)),
  )
}
