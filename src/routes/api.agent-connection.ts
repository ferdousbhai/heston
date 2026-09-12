import { createFileRoute } from '@tanstack/react-router'

import { readAgentConnection } from '../server/agent-connection'
import { authenticateRequest, jsonNoStore } from '../server/http'
import { appEnv } from '../server/worker-env'

/** A member's own agent only: the handler scopes by `identity.id` and reads nothing else. */
export const Route = createFileRoute('/api/agent-connection')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authenticated = await authenticateRequest(request, appEnv)
        if ('response' in authenticated) return authenticated.response
        if (!appEnv.DB) return jsonNoStore({ error: 'Agent connection is unavailable' }, { status: 503 })
        try {
          return jsonNoStore(await readAgentConnection(appEnv.DB, authenticated.identity.id))
        } catch (error) {
          console.error('AgentConnectionReadFailed', error instanceof Error ? error.name : 'UnknownError')
          return jsonNoStore({ error: 'Agent connection is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
