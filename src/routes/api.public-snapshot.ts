import { createFileRoute } from '@tanstack/react-router'
import { waitUntil } from 'cloudflare:workers'

import { servePublicSnapshot } from '../server/public-snapshot-cache'
import { appEnv } from '../server/worker-env'

export const Route = createFileRoute('/api/public-snapshot')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // SAFETY: This server route runs in Cloudflare Workers, whose CacheStorage adds `default`.
        const edgeCache = (caches as CacheStorage & { default: Cache }).default
        // The refresh runs past the response, so the reader never waits on it.
        return servePublicSnapshot(request, appEnv, edgeCache, waitUntil)
      },
    },
  },
})
