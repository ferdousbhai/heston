import { describe, expect, it, vi } from 'vitest'

import { runScheduledJob } from '../src/server/scheduled-jobs'
import { type AppEnv } from '../src/server/env'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'

function jobStore() {
  let status: string | undefined
  const db: D1Database = {
    ...unsupportedDatabase(),
    prepare: vi.fn((sql: string) => ({
      ...unsupportedStatement(),
      bind: (..._values: unknown[]) => ({
        ...unsupportedStatement(),
        run: async () => {
          if (sql.startsWith('INSERT INTO scheduled_runs')) {
            if (status === undefined || status === 'failed') {
              status = 'running'
              return d1Result([], 1)
            }
            return d1Result([], 0)
          }
          if (sql.includes("status = 'completed'")) {
            const changes = status === 'running' ? 1 : 0
            if (changes) status = 'completed'
            return d1Result([], changes)
          }
          if (sql.includes("status = 'failed'")) {
            if (status === 'running') status = 'failed'
            return d1Result([], 1)
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
    await expect(runScheduledJob(env, 'x-catalysts', new Date('2026-08-14T22:30:00Z'), async () => {
      throw new Error('upstream')
    })).rejects.toThrow('upstream')
    expect(store.status()).toBe('failed')
    await expect(runScheduledJob(env, 'x-catalysts', new Date('2026-08-14T22:30:00Z'), async () => undefined))
      .resolves.toBe('completed')
  })
})
