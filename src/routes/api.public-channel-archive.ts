import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { readChannelArchivePage } from '../server/channel-archive'
import { jsonNoStore, jsonPublic } from '../server/http'
import { appEnv } from '../server/worker-env'

const CursorSchema = z.coerce.number().int().positive().optional()

/** The retired channel's surviving posts, newest first. Public and account-free. */
export const Route = createFileRoute('/api/public-channel-archive')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cursor = CursorSchema.safeParse(new URL(request.url).searchParams.get('before') ?? undefined)
        if (!cursor.success) return jsonNoStore({ error: 'Invalid archive cursor' }, { status: 400 })
        if (!appEnv.DB) return jsonNoStore({ error: 'Channel archive is unavailable' }, { status: 503 })
        try {
          const response = jsonPublic(await readChannelArchivePage(appEnv.DB, cursor.data))
          // The archive is finite and does not change, so a page may be kept for a day.
          response.headers.set('Cache-Control', 'public, max-age=3600, s-maxage=86400')
          return response
        } catch (error) {
          console.error('ChannelArchiveUnavailable', error instanceof Error ? error.message : 'UnknownError')
          return jsonNoStore({ error: 'Channel archive is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
