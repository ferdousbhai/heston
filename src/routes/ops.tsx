import { createFileRoute } from '@tanstack/react-router'

import { Button } from '#/components/ui/button'
import { Field, FieldGroup } from '#/components/ui/field'
import { AuthGate } from '../components/auth-gate'

export const Route = createFileRoute('/ops')({
  component: OperationsPage,
  head: () => ({ meta: [{ title: 'Operations | Spice Must Flow' }] }),
})

function OperationsPage() {
  return (
    <AuthGate>
      {() => (
        <main className="ops-page">
          <h1>Operations</h1>
          <p>Run the same daily intelligence job used by Cloudflare Cron. X and Reddit collect concurrently, then both feed catalysts and the Daily Brief. A completed job is not run twice for the same New York market date.</p>
          <FieldGroup className="ops-actions">
            <Field><form action="/api/jobs/daily-research" method="post"><Button size="lg" type="submit" variant="outline">Run daily intelligence</Button></form></Field>
          </FieldGroup>
        </main>
      )}
    </AuthGate>
  )
}
