import { createFileRoute } from '@tanstack/react-router'

import { tastytradeCallback } from '../server/broker-authorizations'
import { appEnv } from '../server/worker-env'

/**
 * tastytrade's redirect URI. Unauthenticated by necessity; it only ever forwards the browser to
 * the member's own loopback listener (see `tastytradeCallback`).
 */
export const Route = createFileRoute('/api/brokers/tastytrade/callback')({
  server: {
    handlers: {
      GET: ({ request }) => tastytradeCallback(request, appEnv),
    },
  },
})
