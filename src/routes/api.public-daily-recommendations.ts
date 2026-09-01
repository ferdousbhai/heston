import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { jsonNoStore, jsonPublic } from '../server/http'
import { readDailyRecommendationsBefore } from '../server/daily-recommendations-store'
import { appEnv } from '../server/worker-env'

const ArchiveCursorSchema = z.string().datetime()

export const Route = createFileRoute('/api/public-daily-recommendations')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cursor = ArchiveCursorSchema.safeParse(new URL(request.url).searchParams.get('before'))
        if (!cursor.success) return jsonNoStore({ error: 'Invalid recommendation cursor' }, { status: 400 })
        if (!appEnv.DB) return jsonNoStore({ error: 'Recommendation archive is unavailable' }, { status: 503 })
        try {
          // Stored recommendations already cross the public snapshot boundary. This route exposes
          // the same validated contract one row at a time and never reads account state.
          const dailyRecommendations = await readDailyRecommendationsBefore(appEnv.DB, cursor.data)
          return jsonPublic({ dailyRecommendations: dailyRecommendations ?? null })
        } catch (error) {
          console.error('PublicDailyRecommendationsArchiveUnavailable', error instanceof Error ? error.message : 'UnknownError')
          return jsonNoStore({ error: 'Recommendation archive is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
