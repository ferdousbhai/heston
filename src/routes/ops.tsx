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
          <p>Start a private, non-publishing preview in the same Cloudflare Workflow used by Cron. It does not consume the market-day receipt or replace the public Daily Read.</p>
          <FieldGroup className="ops-actions">
            <Field><form action="/api/jobs/daily-research" method="post"><Button size="lg" type="submit" variant="outline">Run private preview</Button></form></Field>
          </FieldGroup>
        </main>
      )}
    </AuthGate>
  )
}
