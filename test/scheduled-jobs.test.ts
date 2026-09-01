import { describe, expect, it, vi } from 'vitest'

import { type AppEnv } from '../src/server/env'
import { startDailyResearchWorkflow, startScheduledJob } from '../src/server/scheduled-jobs'

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
      id: 'recommendations-2026-08-14',
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

  it('starts non-publishing previews in the same Workflow with a unique receipt', async () => {
    // SAFETY: the helper only reads the instance id returned by this binding stand-in.
    const create = vi.fn(async ({ id }: { id?: string }) => ({ id } as WorkflowInstance))
    const env: AppEnv = {
      DAILY_RESEARCH_WORKFLOW: {
        create,
        createBatch: vi.fn(),
        deleteBatch: vi.fn(),
        get: vi.fn(),
      },
    }
    const params = {
      persist: false,
      requireMarketOpen: false,
      scheduledAt: '2026-08-29T12:00:00.000Z',
    }

    await expect(startDailyResearchWorkflow(env, params, 'preview-run')).resolves.toBe('preview-run')
    expect(create).toHaveBeenCalledWith({ id: 'preview-run', params })
  })
})
