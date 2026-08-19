import { createFileRoute } from '@tanstack/react-router'

import { toError } from '../domain/failure'

import { appEnv } from '../server/worker-env'
import { authorizePersonalRequest, jsonNoStore, publicError } from '../server/http'
import { SCHEDULED_JOB_KINDS, runScheduledJobKind, type ScheduledJobKind } from '../server/scheduled-jobs'

function isScheduledJobKind(value: string): value is ScheduledJobKind {
  return SCHEDULED_JOB_KINDS.some((kind) => kind === value)
}

export const Route = createFileRoute('/api/jobs/$jobKind')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const unauthorized = await authorizePersonalRequest(request, appEnv, true)
        if (unauthorized) return unauthorized
        if (!isScheduledJobKind(params.jobKind)) {
          return jsonNoStore({ error: 'Unknown job' }, { status: 404 })
        }
        try {
          const runAt = new Date()
          const status = await runScheduledJobKind(appEnv, params.jobKind, runAt)
          return jsonNoStore({ job: params.jobKind, runAt: runAt.toISOString(), status })
        } catch (error) {
          return jsonNoStore({ error: publicError(toError(error)) }, { status: 502 })
        }
      },
    },
  },
})
