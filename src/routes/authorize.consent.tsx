import { useState } from 'react'
import { createFileRoute, useLocation } from '@tanstack/react-router'
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
const FailureSchema = z.object({ error_description: z.string().min(1) })

function ConsentPage() {
  const viewer = useViewer()
  const search = useLocation({ select: (location) => location.searchStr })
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string>()

  const answer = async (accept: boolean) => {
    setSubmitting(true)
    setFailure(undefined)
    try {
      // The authorization request comes back as `oauth_query`: the provider signed it on the way
      // here and re-verifies that signature before it will read the answer, which is what stops a
      // consent from being posted for a request nobody made. Posting only the answer -- as this
      // first did -- is refused with "missing oauth query", and the button appeared to do nothing.
      const response = await fetch('/api/auth/oauth2/consent', {
        body: JSON.stringify({ accept, oauth_query: search }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok) {
        // Say what the provider said. A generic message here is how a refused consent looked
        // like a button that did nothing at all.
        const reason = FailureSchema.safeParse(await response.json().catch(() => undefined))
        throw new Error(reason.success ? reason.data.error_description : 'Spice could not record that answer.')
      }
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
            An agent is asking to connect to your Spice account, signed in as{' '}
            <strong>{viewer.user.name}</strong>. It will be able to read market data, research and
            the daily brief, and to see and change your watchlist and favorites.
          </p>
          <p>
            It cannot reach your brokerage this way. Balances, positions and order placement need a
            broker credential that stays on your own machine and is sent with each request.
          </p>
          <p>
            Approve only if you started this from your own agent. You can revoke it later from the
            Connect tab.
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
