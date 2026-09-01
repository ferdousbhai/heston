import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { CatalystRefreshSchema } from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { refreshCatalystsForSymbol } from '../server/catalyst-refresh'
import { jsonNoStore } from '../server/http'
import { appEnv } from '../server/worker-env'

const RefreshRequestSchema = z.strictObject({ symbol: EquitySymbolSchema })

/**
 * Reader attention is what keeps catalyst coverage seeded: a favorite from anyone, signed in
 * or not, and a look at a symbol whose next month is empty. The window that decides whether a
 * search is actually bought lives on the server, so this route is safe to call on every one.
 */
export const Route = createFileRoute('/api/public-catalyst-refresh')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const parsed = RefreshRequestSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return jsonNoStore({ error: 'Name one symbol' }, { status: 400 })
        if (!appEnv.DB) return jsonNoStore({ error: 'Catalyst research is unavailable' }, { status: 503 })
        try {
          const refresh = await refreshCatalystsForSymbol(appEnv, parsed.data.symbol)
          return jsonNoStore(CatalystRefreshSchema.parse({
            catalysts: refresh.catalysts,
            ran: refresh.ran,
          }))
        } catch (error) {
          console.error('CatalystRefreshUnavailable', error instanceof Error ? error.message : 'UnknownError')
          return jsonNoStore({ error: 'Catalyst research is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
