import { useEffect } from 'react'
import { createFileRoute, useLocation } from '@tanstack/react-router'

import { Spinner } from '#/components/ui/spinner'
import { GoogleSignInButton, useViewer } from '../components/auth-gate'

/**
 * Where an MCP client's authorization request lands when nobody is signed in.
 *
 * The provider redirects here carrying the whole authorization request as signed query
 * parameters. This page's only job is to get a session and hand that request straight back: it
 * never inspects or rebuilds the parameters, because they are signed as a set and altering any of
 * them invalidates the request.
 *
 * The first version of this pointed `loginPage` at `/connect`, which is a tab inside the
 * application rather than a route -- so the browser reached a 404 with the authorization request
 * in its address bar and the flow simply stopped.
 */
export const Route = createFileRoute('/authorize')({
  component: AuthorizePage,
  head: () => ({ meta: [{ title: 'Connect your agent | Spice Must Flow' }] }),
})

function AuthorizePage() {
  const viewer = useViewer()
  const signedIn = viewer.phase === 'ready' && viewer.user !== null
  // The router carries the raw query, which renders the same on the server and in the browser.
  // The parameters are signed as a set, so they are only ever passed along whole.
  const search = useLocation({ select: (location) => location.searchStr })

  useEffect(() => {
    if (!signedIn) return
    // Signed in: hand the request back to the provider rather than deciding anything here. It
    // owns what comes next -- consent, or the redirect to the client with a code.
    window.location.replace(`/api/auth/oauth2/authorize?${search}`)
  }, [search, signedIn])

  return (
    <main className="authorize-page">
      <h1>Connect your agent</h1>
      {viewer.phase === 'checking' && <Spinner />}
      {viewer.phase === 'error' && (
        <p className="authorize-error">
          Spice could not check whether you are signed in. Reload to try again.
        </p>
      )}
      {viewer.phase === 'ready' && viewer.user === null && (
        <>
          <p>
            An agent is asking to connect to Spice as you. Sign in to continue, and you will be
            returned here automatically.
          </p>
          <GoogleSignInButton callbackURL={`/authorize?${search}`} />
        </>
      )}
      {viewer.phase === 'ready' && viewer.user !== null && (
        <p>Signed in as {viewer.user.name}. Continuing…</p>
      )}
    </main>
  )
}
