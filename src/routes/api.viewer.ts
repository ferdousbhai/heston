import { createFileRoute } from '@tanstack/react-router'

import { getOwnerSession } from '../server/auth'
import { appEnv } from '../server/worker-env'
import { jsonNoStore } from '../server/http'

export const Route = createFileRoute('/api/viewer')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const session = await getOwnerSession(request, appEnv)
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
