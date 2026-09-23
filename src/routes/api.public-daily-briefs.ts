import { createFileRoute } from '@tanstack/react-router'
import { toError } from '../domain/failure'
import { IsoDateSchema } from '../domain/iso-date'
import { ARCHIVE_RESPONSE_CACHE_CONTROL, jsonNoStore, jsonPublic } from '../server/http'
import { readDailyBriefBefore } from '../server/daily-brief-store'
import { appEnv } from '../server/worker-env'

// The cursor is the market date of the brief the reader is on; the archive walks by market
// date, so a late republish of an older date cannot reorder it.
const ArchiveCursorSchema = IsoDateSchema

export const Route = createFileRoute('/api/public-daily-briefs')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const cursor = ArchiveCursorSchema.safeParse(new URL(request.url).searchParams.get('before'))
        if (!cursor.success) return jsonNoStore({ error: 'Invalid brief cursor' }, { status: 400 })
        if (!appEnv.DB) return jsonNoStore({ error: 'Brief archive is unavailable' }, { status: 503 })
        try {
          // The brief already crosses the public snapshot boundary; this exposes the same
          // validated contract one row at a time and never reads account state.
          const response = jsonPublic({ brief: (await readDailyBriefBefore(appEnv.DB, cursor.data)) ?? null })
          response.headers.set('Cache-Control', ARCHIVE_RESPONSE_CACHE_CONTROL)
          return response
        } catch (error) {
          console.error('PublicDailyBriefArchiveUnavailable', toError(error)?.name ?? 'UnknownError')
          return jsonNoStore({ error: 'Brief archive is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
