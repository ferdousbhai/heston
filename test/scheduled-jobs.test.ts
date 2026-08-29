import { describe, expect, it, vi } from 'vitest'

import { type AppEnv } from '../src/server/env'
import { startScheduledJob } from '../src/server/scheduled-jobs'

describe('scheduled daily research Workflow', () => {
  it('starts one date-keyed production run with explicit parameters', async () => {
    const instance: WorkflowInstance = {
      delete: vi.fn(),
      id: 'workflow-instance',
      pause: vi.fn(),
      restart: vi.fn(),
      resume: vi.fn(),
      sendEvent: vi.fn(),
      status: vi.fn(),
      terminate: vi.fn(),
    }
    const create = vi.fn(async () => instance)
    const env: AppEnv = {
      DAILY_RESEARCH_WORKFLOW: {
        create,
        createBatch: vi.fn(),
        deleteBatch: vi.fn(),
        get: vi.fn(),
      },
    }
    const scheduledAt = new Date('2026-08-14T13:30:00.000Z')

    await expect(startScheduledJob(env, 'daily-research', scheduledAt)).resolves.toBe('workflow-instance')
    expect(create).toHaveBeenCalledWith({
      id: 'brief-2026-08-14',
      params: {
        persist: true,
        requireMarketOpen: true,
        scheduledAt: scheduledAt.toISOString(),
      },
    })
  })

  it('fails closed when the Workflow binding is absent', async () => {
    await expect(startScheduledJob({}, 'daily-research'))
      .rejects.toThrow('DailyResearchWorkflowUnavailable')
  })
})
