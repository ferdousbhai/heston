import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { resolvePendingAction } from '../server/agent'
import { ConfirmRequestSchema } from '../server/agent-contracts'
import { type AppEnv } from '../server/env'
import { authorizePersonalRequest, jsonNoStore, publicError } from '../server/http'

export const Route = createFileRoute('/api/actions/$actionId')({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const workerEnv = env as unknown as AppEnv
        const unauthorized = await authorizePersonalRequest(request, workerEnv, true)
        if (unauthorized) return unauthorized
        const parsed = ConfirmRequestSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return jsonNoStore({ error: 'Invalid confirmation' }, { status: 400 })
        try {
          return jsonNoStore(await resolvePendingAction(workerEnv, params.actionId, parsed.data))
        } catch (error) {
          return jsonNoStore({ error: publicError(error) }, { status: 409 })
        }
      },
    },
  },
})
