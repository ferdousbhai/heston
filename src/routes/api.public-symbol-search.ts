import { createFileRoute } from '@tanstack/react-router'

import { servePublicSymbolSearch } from '../server/public-symbol-search'
import { appEnv } from '../server/worker-env'

export const Route = createFileRoute('/api/public-symbol-search')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // SAFETY: This server route runs in Cloudflare Workers, whose CacheStorage adds `default`.
        const edgeCache = (caches as CacheStorage & { default: Cache }).default
        return servePublicSymbolSearch(request, appEnv, edgeCache)
      },
    },
  },
})
