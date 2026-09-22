import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { readChannelArchivePage } from '../server/channel-archive'
import { toError } from '../domain/failure'
import { ARCHIVE_RESPONSE_CACHE_CONTROL, jsonNoStore, jsonPublic } from '../server/http'
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
          response.headers.set('Cache-Control', ARCHIVE_RESPONSE_CACHE_CONTROL)
          return response
        } catch (error) {
          console.error('ChannelArchiveUnavailable', toError(error)?.name ?? 'UnknownError')
          return jsonNoStore({ error: 'Channel archive is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
