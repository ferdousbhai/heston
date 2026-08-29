import { createFileRoute } from '@tanstack/react-router'

import { toError } from '../domain/failure'

import { resolvePendingAction } from '../server/agent'
import { ConfirmRequestSchema } from '../server/agent-contracts'
import { appEnv } from '../server/worker-env'
import { authorizePersonalRequest, jsonNoStore, ownerHttpFailure } from '../server/http'

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
          // The boundary mapper preserves an ambiguous broker mutation as an upstream
          // indeterminate result, so clients never treat it like a fresh draft conflict.
          const failure = ownerHttpFailure(toError(error), 409)
          return jsonNoStore({ error: failure.message }, { status: failure.status })
        }
      },
    },
  },
})
