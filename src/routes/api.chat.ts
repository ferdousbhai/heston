import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { chatWithAgent } from '../server/agent'
import { ChatRequestSchema } from '../server/agent-contracts'
import { type AppEnv } from '../server/env'
import { authorizePersonalRequest, jsonNoStore, publicError } from '../server/http'

export const Route = createFileRoute('/api/chat')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const workerEnv = env as unknown as AppEnv
        const unauthorized = await authorizePersonalRequest(request, workerEnv, true)
        if (unauthorized) return unauthorized
        const parsed = ChatRequestSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return jsonNoStore({ error: 'Enter a valid message' }, { status: 400 })
        try {
          return jsonNoStore(await chatWithAgent(workerEnv, parsed.data))
        } catch (error) {
          console.error('AgentChatFailed', error instanceof Error ? `${error.name}:${error.message.slice(0, 500)}` : 'UnknownError')
          return jsonNoStore({ error: publicError(error) }, { status: 502 })
        }
      },
    },
  },
})
