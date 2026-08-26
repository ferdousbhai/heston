import { describe, expect, it, vi } from 'vitest'

import { runScheduledJob } from '../src/server/scheduled-jobs'
import { type AppEnv } from '../src/server/env'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'

function jobStore() {
  let status: string | undefined
  let startedAt: string | undefined
  const db: D1Database = {
    ...unsupportedDatabase(),
    prepare: vi.fn((sql: string) => ({
      ...unsupportedStatement(),
      bind: (...values: unknown[]) => ({
        ...unsupportedStatement(),
        run: async () => {
          if (sql.startsWith('INSERT INTO scheduled_runs')) {
            const nextStartedAt = String(values[4])
            const staleBefore = String(values[5])
            if (status === undefined || status === 'failed' || (status === 'running' && startedAt !== undefined && startedAt <= staleBefore)) {
              status = 'running'
              startedAt = nextStartedAt
              return d1Result([], 1)
            }
            return d1Result([], 0)
          }
          if (sql.includes("status = 'completed'")) {
            const changes = status === 'running' && startedAt === values[2] ? 1 : 0
            if (changes) status = 'completed'
            return d1Result([], changes)
          }
          if (sql.includes("status = 'failed'")) {
            const changes = status === 'running' && startedAt === values[3] ? 1 : 0
            if (changes) status = 'failed'
            return d1Result([], changes)
          }
          throw new Error('Unexpected SQL')
        },
      }),
    })),
  }
  return { db, status: () => status }
}

describe('scheduled job receipt boundary', () => {
  it('records one durable completion per New York market date', async () => {
    const store = jobStore()
    const task = vi.fn(async () => undefined)
    const env: AppEnv = { DB: store.db }
    const at = new Date('2026-08-14T13:30:00.000Z')

    await expect(runScheduledJob(env, 'daily-research', at, task)).resolves.toBe('completed')
    await expect(runScheduledJob(env, 'daily-research', at, task)).resolves.toBe('skipped')
    expect(task).toHaveBeenCalledTimes(1)
    expect(store.status()).toBe('completed')
  })

  it('records a failure and permits the next durable retry', async () => {
    const store = jobStore()
    const env: AppEnv = { DB: store.db }
    await expect(runScheduledJob(env, 'daily-research', new Date('2026-08-14T13:30:00Z'), async () => {
      throw new Error('upstream')
    })).rejects.toThrow('upstream')
    expect(store.status()).toBe('failed')
    await expect(runScheduledJob(env, 'daily-research', new Date('2026-08-14T13:30:00Z'), async () => undefined))
      .resolves.toBe('completed')
  })

  it('does not let an expired invocation resolve a newer reclaimed run', async () => {
    vi.useFakeTimers()
    const failedLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      vi.setSystemTime(new Date('2026-08-14T13:30:00.000Z'))
      const store = jobStore()
      const env: AppEnv = { DB: store.db }
      let releaseFirst: (() => void) | undefined
      let releaseSecond: (() => void) | undefined
      const first = runScheduledJob(env, 'daily-research', new Date(), () => new Promise<void>((resolve) => { releaseFirst = resolve }))
      await vi.waitFor(() => expect(releaseFirst).toBeTypeOf('function'))

      vi.setSystemTime(new Date('2026-08-14T15:30:00.001Z'))
      const second = runScheduledJob(env, 'daily-research', new Date('2026-08-14T13:30:00.000Z'), () => new Promise<void>((resolve) => { releaseSecond = resolve }))
      await vi.waitFor(() => expect(releaseSecond).toBeTypeOf('function'))

      releaseFirst?.()
      await expect(first).rejects.toThrow('ScheduledJobReceiptNotRecorded')
      expect(store.status()).toBe('running')

      releaseSecond?.()
      await expect(second).resolves.toBe('completed')
      expect(store.status()).toBe('completed')
    } finally {
      failedLog.mockRestore()
      vi.useRealTimers()
    }
  })
})
