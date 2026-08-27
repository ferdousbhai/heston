import { createFileRoute } from '@tanstack/react-router'

import { getAuthenticatedIdentity, isOwnerEmail } from '../server/auth'
import { appEnv } from '../server/worker-env'
import { jsonNoStore } from '../server/http'

export const Route = createFileRoute('/api/viewer')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const identity = await getAuthenticatedIdentity(request, appEnv)
          return jsonNoStore({
            authRequired: true,
            user: identity ? {
              id: identity.id,
              name: identity.name,
              role: isOwnerEmail(identity.email) ? 'owner' : 'member',
            } : null,
          })
        } catch (error) {
          console.error('ViewerAuthUnavailable', error instanceof Error ? error.message : 'UnknownError')
          return jsonNoStore({ error: 'Authentication is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
