import { createFileRoute } from '@tanstack/react-router'

import { toError } from '../domain/failure'

import { resolvePendingAction } from '../server/agent'
import { ConfirmRequestSchema } from '../server/agent-contracts'
import { appEnv } from '../server/worker-env'
import { authorizePersonalRequest, jsonNoStore, publicError } from '../server/http'

export const Route = createFileRoute('/api/actions/$actionId')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const unauthorized = await authorizePersonalRequest(request, appEnv, true)
        if (unauthorized) return unauthorized
        const parsed = ConfirmRequestSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return jsonNoStore({ error: 'Invalid confirmation' }, { status: 400 })
        try {
          return jsonNoStore(await resolvePendingAction(appEnv, params.actionId, parsed.data))
        } catch (error) {
          const cause = toError(error)
          // An unknown broker submission is an upstream indeterminate result, not
          // a confirmation-state conflict. Clients must not treat it like a fresh draft.
          const status = cause?.name === 'BrokerageSubmissionUnknownError' ? 502 : 409
          return jsonNoStore({ error: publicError(cause) }, { status })
        }
      },
    },
  },
})
