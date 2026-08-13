import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/api/health')({
  server: {
    handlers: {
      GET: () => Response.json({ service: 'spice', status: 'ok' }),
    },
  },
})
