import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { jsonNoStore, jsonPublic } from '../server/http'
import { readResearchBriefBefore } from '../server/research-brief-store'
import { appEnv } from '../server/worker-env'

const ArchiveCursorSchema = z.string().datetime()

export const Route = createFileRoute('/api/public-research-brief')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cursor = ArchiveCursorSchema.safeParse(new URL(request.url).searchParams.get('before'))
        if (!cursor.success) return jsonNoStore({ error: 'Invalid research brief cursor' }, { status: 400 })
        if (!appEnv.DB) return jsonNoStore({ error: 'Research archive is unavailable' }, { status: 503 })
        try {
          // Stored briefs already cross the public snapshot boundary. This route exposes
          // the same validated contract one row at a time and never reads account state.
          const brief = await readResearchBriefBefore(appEnv.DB, cursor.data)
          return jsonPublic({ brief: brief ?? null })
        } catch (error) {
          console.error('PublicResearchBriefArchiveUnavailable', error instanceof Error ? error.message : 'UnknownError')
          return jsonNoStore({ error: 'Research archive is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
