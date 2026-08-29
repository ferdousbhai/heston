import { createFileRoute } from '@tanstack/react-router'

import { toError } from '../domain/failure'

import { appEnv } from '../server/worker-env'
import { authorizePersonalRequest, jsonNoStore, publicError } from '../server/http'
import {
  SCHEDULED_JOB_KINDS,
  startDailyResearchWorkflow,
  type ScheduledJobKind,
} from '../server/scheduled-jobs'

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
          // A preview gets its own Workflow identity and never writes the public brief,
          // catalyst tables, scheduled watchlist origins, or the daily Cron receipt.
          const instanceId = await startDailyResearchWorkflow(appEnv, {
            persist: false,
            requireMarketOpen: false,
            scheduledAt: runAt.toISOString(),
          })
          return jsonNoStore({ instanceId, job: params.jobKind, runAt: runAt.toISOString(), status: 'started' }, { status: 202 })
        } catch (error) {
          console.error('DailyResearchPreviewFailed', toError(error)?.message ?? 'UnknownError')
          return jsonNoStore({ error: publicError(toError(error)) }, { status: 502 })
        }
      },
    },
  },
})
