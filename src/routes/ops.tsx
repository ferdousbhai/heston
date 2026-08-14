import { createFileRoute } from '@tanstack/react-router'

import { AuthGate } from '../components/auth-gate'

export const Route = createFileRoute('/ops')({
  component: OperationsPage,
  head: () => ({ meta: [{ title: 'Operations — Spice Must Flow' }] }),
})

function OperationsPage() {
  return (
    <AuthGate>
      {() => (
        <main className="ops-page">
          <h1>Operations</h1>
          <p>Run the same durable jobs used by Cloudflare Cron. A completed job is not run twice for the same New York market date.</p>
          <form action="/api/jobs/daily-research" method="post">
            <button type="submit">Run daily research</button>
          </form>
          <form action="/api/jobs/x-catalysts" method="post">
            <button type="submit">Run catalyst research</button>
          </form>
        </main>
      )}
    </AuthGate>
  )
}
