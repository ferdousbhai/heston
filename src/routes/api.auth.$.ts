import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { getAuthRuntime } from '../server/auth'
import { type AppEnv } from '../server/env'

async function handleAuth(request: Request) {
  const workerEnv = env as unknown as AppEnv
  try {
    const { auth } = await getAuthRuntime(workerEnv)
    return auth.handler(request)
  } catch (error) {
    console.error('AuthUnavailable', error instanceof Error ? error.message : 'UnknownError')
    return Response.json({ error: 'Authentication is temporarily unavailable' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleAuth(request),
      POST: ({ request }) => handleAuth(request),
    },
  },
})
