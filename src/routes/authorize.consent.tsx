import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { Button } from '#/components/ui/button'
import { Spinner } from '#/components/ui/spinner'
import { useViewer } from '../components/auth-gate'

/**
 * The consent step: what stands between a self-registered client and a member's account.
 *
 * Registration is open, because that is how an MCP client bootstraps -- it invents its own
 * credentials and asks. Nothing about holding a client id says the person meant to grant it
 * anything, so approval is asked for here every time the provider decides consent is needed, and
 * denial is a real answer rather than a way to close the tab.
 *
 * The provider owns the decision and the outcome. This page reports the member's answer and
 * follows the redirect it is given; it never constructs a redirect back to the client itself.
 */
export const Route = createFileRoute('/authorize/consent')({
  component: ConsentPage,
  head: () => ({ meta: [{ title: 'Approve access | Spice Must Flow' }] }),
})

const ConsentResponseSchema = z.object({ redirectURI: z.string().min(1) })

function ConsentPage() {
  const viewer = useViewer()
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string>()

  const answer = async (accept: boolean) => {
    setSubmitting(true)
    setFailure(undefined)
    try {
      // The consent code travels in a signed cookie the provider set on the way here, so the
      // browser supplies it and this page never has to hold it.
      const response = await fetch('/api/auth/oauth2/consent', {
        body: JSON.stringify({ accept }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok) throw new Error('Spice could not record that answer.')
      const { redirectURI } = ConsentResponseSchema.parse(await response.json())
      window.location.replace(redirectURI)
    } catch (error) {
      setSubmitting(false)
      setFailure(error instanceof Error ? error.message : 'Spice could not record that answer.')
    }
  }

  return (
    <main className="authorize-page">
      <h1>Approve access</h1>
      {viewer.phase === 'checking' && <Spinner />}
      {viewer.phase === 'ready' && viewer.user === null && (
        <p>You are not signed in. Start the connection again from your agent.</p>
      )}
      {viewer.phase === 'ready' && viewer.user !== null && (
        <>
          <p>
            An agent is asking to act as <strong>{viewer.user.name}</strong> on Spice: market data,
            research, your watchlist and your favorites.
          </p>
          <p>
            It cannot reach your brokerage through this. Balances, positions and order placement
            need a broker credential that stays on your own machine and is sent per request.
          </p>
          {failure && <p className="authorize-error">{failure}</p>}
          <div className="authorize-actions">
            <Button disabled={submitting} onClick={() => void answer(true)} type="button">
              {submitting ? <Spinner data-icon="inline-start" /> : null}
              <span>Approve</span>
            </Button>
            <Button
              disabled={submitting}
              onClick={() => void answer(false)}
              type="button"
              variant="outline"
            >
              Deny
            </Button>
          </div>
        </>
      )}
    </main>
  )
}
