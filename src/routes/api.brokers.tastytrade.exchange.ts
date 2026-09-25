import { createFileRoute } from '@tanstack/react-router'

import { exchangeTastytrade } from '../server/broker-authorizations'
import { appEnv } from '../server/worker-env'

/** Redeems a pending connection for the member's refresh token, once, with their agent token. */
export const Route = createFileRoute('/api/brokers/tastytrade/exchange')({
  server: {
    handlers: {
      POST: ({ request }) => exchangeTastytrade(request, appEnv),
    },
  },
})
