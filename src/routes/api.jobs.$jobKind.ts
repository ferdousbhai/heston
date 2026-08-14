import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { type AppEnv } from '../server/env'
import { authorizePersonalRequest, jsonNoStore, publicError } from '../server/http'
import { SCHEDULED_JOB_KINDS, runScheduledJobKind, type ScheduledJobKind } from '../server/scheduled-jobs'

function isScheduledJobKind(value: string): value is ScheduledJobKind {
  return SCHEDULED_JOB_KINDS.includes(value as ScheduledJobKind)
}

export const Route = createFileRoute('/api/jobs/$jobKind')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const workerEnv = env as unknown as AppEnv
        const unauthorized = await authorizePersonalRequest(request, workerEnv, true)
        if (unauthorized) return unauthorized
        if (!isScheduledJobKind(params.jobKind)) {
          return jsonNoStore({ error: 'Unknown job' }, { status: 404 })
        }
        try {
          const runAt = new Date()
          const status = await runScheduledJobKind(workerEnv, params.jobKind, runAt)
          return jsonNoStore({ job: params.jobKind, runAt: runAt.toISOString(), status })
        } catch (error) {
          return jsonNoStore({ error: publicError(error) }, { status: 502 })
        }
      },
    },
  },
})
