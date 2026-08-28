import { createFileRoute } from '@tanstack/react-router'

import { toError } from '../domain/failure'

import { appEnv } from '../server/worker-env'
import { authorizePersonalRequest, jsonNoStore, publicError } from '../server/http'
import { generateDailyResearch } from '../server/research'
import { SCHEDULED_JOB_KINDS, type ScheduledJobKind } from '../server/scheduled-jobs'

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
          // An owner preview is deliberately outside the durable Cron receipt and does
          // not write the public brief, catalyst tables, or scheduled watchlist origins.
          const brief = await generateDailyResearch(appEnv, runAt, { persist: false })
          return jsonNoStore({ brief, job: params.jobKind, runAt: runAt.toISOString(), status: 'preview' })
        } catch (error) {
          return jsonNoStore({ error: publicError(toError(error)) }, { status: 502 })
        }
      },
    },
  },
})
