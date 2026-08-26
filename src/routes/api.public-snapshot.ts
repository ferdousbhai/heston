import { createFileRoute } from '@tanstack/react-router'

import { jsonNoStore, jsonPublic } from '../server/http'
import { brokerApi } from '../server/tastytrade'
import { appEnv } from '../server/worker-env'

export const Route = createFileRoute('/api/public-snapshot')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cacheUrl = new URL(request.url)
        cacheUrl.search = ''
        // Version the private Cache API key so a deploy cannot serve a response
        // serialized under an older public privacy contract for another minute.
        cacheUrl.searchParams.set('schema', '2')
        const cacheKey = new Request(cacheUrl, { method: 'GET' })
        // SAFETY: This server route runs in Cloudflare Workers, whose CacheStorage adds `default`.
        const edgeCache = (caches as CacheStorage & { default: Cache }).default
        const cached = await edgeCache.match(cacheKey).catch(() => undefined)
        if (cached) return cached
        try {
          const response = jsonPublic(await brokerApi().loadPublicMarketSnapshot(appEnv))
          await edgeCache.put(cacheKey, response.clone()).catch(() => undefined)
          return response
        } catch (error) {
          console.error('PublicMarketSnapshotUnavailable', error instanceof Error ? error.message : 'UnknownError')
          return jsonNoStore({ error: 'Public market sync is temporarily unavailable' }, { status: 502 })
        }
      },
    },
  },
})
