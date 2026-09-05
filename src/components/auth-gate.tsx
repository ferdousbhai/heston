import { useEffect, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { z } from 'zod'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import { Spinner } from '#/components/ui/spinner'
import { authClient } from '../data/auth-client'
import { toError } from '../domain/failure'

const ViewerSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  role: z.enum(['member', 'owner']),
})

export type Viewer = z.infer<typeof ViewerSchema>

const ViewerResponseSchema = z.object({
  authRequired: z.boolean(),
  user: ViewerSchema.nullable(),
})

export type AuthState =
  | { phase: 'checking' }
  | { phase: 'ready'; user: Viewer | null }
  | { message: string; phase: 'error' }

export function useViewer(): AuthState {
  const [state, setState] = useState<AuthState>({ phase: 'checking' })

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/viewer', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error('Authentication is temporarily unavailable')
      const result = ViewerResponseSchema.parse(await response.json())
      setState({ phase: 'ready', user: result.user })
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return
      const error = toError(cause)
      setState({ message: error ? error.message : 'Authentication failed', phase: 'error' })
    })
    return () => controller.abort()
  }, [])

  return state
}

export function AuthGate({ children }: { children: (viewer: Viewer) => ReactNode }) {
  const state = useViewer()

  if (state.phase === 'checking') return <AuthScreen checking />
  if (state.phase === 'error') return <AuthScreen error={state.message} />
  if (!state.user) return <AuthScreen />
  if (state.user.role !== 'owner') return <OwnerAccessScreen signedIn />
  return children(state.user)
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" data-icon="inline-start" viewBox="0 0 24 24">
      <path d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.4Z" fill="#4285F4" />
      <path d="M12 22c2.7 0 4.98-.9 6.63-2.43l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z" fill="#34A853" />
      <path d="M6.39 13.86A6 6 0 0 1 6.08 12c0-.65.11-1.28.31-1.86V7.52H3.04A10 10 0 0 0 2 12c0 1.61.39 3.14 1.04 4.48l3.35-2.62Z" fill="#FBBC05" />
      <path d="M12 6.01c1.47 0 2.79.51 3.83 1.5l2.87-2.88A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.96 5.52l3.35 2.62C7.18 7.77 9.39 6.01 12 6.01Z" fill="#EA4335" />
    </svg>
  )
}
/**
 * `callbackURL` exists for the OAuth authorization page, which must return the browser to the
 * signed authorization request it arrived with rather than to the application root.
 */
export function GoogleSignInButton(
  { callbackURL = '/', compact = false }: { callbackURL?: string; compact?: boolean },
) {
  const [submitting, setSubmitting] = useState(false)
  const [signInError, setSignInError] = useState<string>()
  const beginSignIn = async () => {
    setSubmitting(true)
    setSignInError(undefined)
    try {
      const result = await authClient.signIn.social({ provider: 'google', callbackURL })
      if (result.error) throw new Error(result.error.message ?? 'Google sign-in failed')
    } catch (signInFailure) {
      setSubmitting(false)
      setSignInError(signInFailure instanceof Error ? signInFailure.message : 'Google sign-in failed')
    }
  }

  return (
    <>
      <Button
        className={compact ? 'owner-sign-in' : 'google-sign-in'}
        disabled={submitting}
        onClick={() => void beginSignIn()}
        size={compact ? 'sm' : 'auth'}
        type="button"
        variant={compact ? 'outline' : 'inverted'}
      >
        {!compact && !submitting && <GoogleMark />}
        {submitting && <Spinner data-icon="inline-start" />}
        <span>{submitting ? 'Opening Google…' : compact ? 'Sign in' : 'Continue with Google'}</span>
      </Button>
      {signInError && (
        <Alert className="auth-inline-error" variant="destructive">
          <AlertTitle>Google sign-in failed</AlertTitle>
          <AlertDescription>{signInError}</AlertDescription>
        </Alert>
      )}
    </>
  )
}

export function OwnerAccessScreen({
  authError,
  signedIn = false,
}: {
  authError?: string
  signedIn?: boolean
}) {
  return (
    <section className="owner-access" aria-labelledby="owner-access-title">
      <p className="owner-access-kicker">Connect your agent</p>
      <h1 id="owner-access-title">
        {signedIn ? <>This page is<br /><em>owner-only.</em></> : <>Your agent.<br />Your <em>account.</em></>}
      </h1>
      <p>{signedIn
        ? 'Operations remain restricted to the owner account. Everything else — the market surface, your favorites, and connecting your own agent — is already yours.'
        : 'Sign in with Google to connect your own agent to Spice, sync your favorites across devices, and — with your own brokerage credentials — read your account and place guarded orders.'}</p>
      {authError && (
        <Alert className="owner-access-error" variant="destructive">
          <AlertTitle>Owner sign-in unavailable</AlertTitle>
          <AlertDescription>{authError}</AlertDescription>
        </Alert>
      )}
      {!signedIn && <GoogleSignInButton />}
    </section>
  )
}

export function AuthScreen({ checking = false, error }: { checking?: boolean; error?: string }) {

  return (
    <main className="auth-shell">
      <header className="auth-brand" aria-label="Spice Must Flow">
        <img alt="" src="/spice-mark.svg" />
        <span>SPICE<small>MUST FLOW</small></span>
      </header>
      <section className="auth-copy" aria-busy={checking}>
        <h1>Your market.<br /><em>In motion.</em></h1>
        <p>Public options intelligence and a daily market read. Sign in to connect your own agent and sync your favorites; your brokerage credentials stay on your machine.</p>
        {checking ? (
          <div className="auth-checking" role="status"><Spinner />Checking your session</div>
        ) : error ? (
          <Alert className="auth-error" variant="destructive">
            <AlertTitle>Session check failed</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
            <Button onClick={() => window.location.reload()} size="sm" type="button" variant="outline">Try again</Button>
          </Alert>
        ) : (
          <GoogleSignInButton />
        )}
      </section>
      <footer className="auth-footer">
        <span>Synced favorites · bring your own agent</span>
        <nav aria-label="Legal and support">
          <Link to="/support">Support</Link>
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/disclosures">Disclosures</Link>
        </nav>
      </footer>
    </main>
  )
}
