import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getOwnerSession } from '../server/auth'
import { type AppEnv } from '../server/env'
import { jsonNoStore } from '../server/http'

export const Route = createFileRoute('/api/viewer')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const workerEnv = env as unknown as AppEnv
        try {
          const session = await getOwnerSession(request, workerEnv)
          return jsonNoStore({
            authRequired: true,
            user: session ? { name: session.user.name } : null,
          })
        } catch (error) {
          console.error('ViewerAuthUnavailable', error instanceof Error ? error.message : 'UnknownError')
          return jsonNoStore({ error: 'Authentication is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
