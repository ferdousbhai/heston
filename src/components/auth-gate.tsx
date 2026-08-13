import { useEffect, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'

import { authClient } from '../data/auth-client'

export type Viewer = {
  image: string | null
  name: string
}

type ViewerResponse = {
  authRequired: boolean
  user: Viewer | null
}

type AuthState =
  | { phase: 'checking' }
  | { phase: 'ready'; user: Viewer | null }
  | { message: string; phase: 'error' }
  | { phase: 'guest' }

export function AuthGate({ children }: { children: (viewer: Viewer | null) => ReactNode }) {
  const [state, setState] = useState<AuthState>({ phase: 'checking' })

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/viewer', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error('Authentication is temporarily unavailable')
      const result = await response.json() as ViewerResponse
      setState(result.authRequired && !result.user ? { phase: 'guest' } : { phase: 'ready', user: result.user })
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setState({ phase: 'ready', user: null })
        return
      }
      setState({ message: error instanceof Error ? error.message : 'Authentication failed', phase: 'error' })
    })
    return () => controller.abort()
  }, [])

  if (state.phase === 'checking') return <AuthScreen checking />
  if (state.phase === 'guest') return <AuthScreen />
  if (state.phase === 'error') return <AuthScreen error={state.message} />
  return children(state.user)
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.4Z" fill="#4285F4" />
      <path d="M12 22c2.7 0 4.98-.9 6.63-2.43l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z" fill="#34A853" />
      <path d="M6.39 13.86A6 6 0 0 1 6.08 12c0-.65.11-1.28.31-1.86V7.52H3.04A10 10 0 0 0 2 12c0 1.61.39 3.14 1.04 4.48l3.35-2.62Z" fill="#FBBC05" />
      <path d="M12 6.01c1.47 0 2.79.51 3.83 1.5l2.87-2.88A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.96 5.52l3.35 2.62C7.18 7.77 9.39 6.01 12 6.01Z" fill="#EA4335" />
    </svg>
  )
}
function AuthScreen({ checking = false, error }: { checking?: boolean; error?: string }) {
  const [submitting, setSubmitting] = useState(false)
  const [signInError, setSignInError] = useState<string>()
  const beginSignIn = async () => {
    setSubmitting(true)
    setSignInError(undefined)
    try {
      const result = await authClient.signIn.social({ provider: 'google', callbackURL: '/' })
      if (result.error) throw new Error(result.error.message ?? 'Google sign-in failed')
    } catch (signInFailure) {
      setSubmitting(false)
      setSignInError(signInFailure instanceof Error ? signInFailure.message : 'Google sign-in failed')
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-grain" />
      <header className="auth-brand" aria-label="Spice Must Flow">
        <img alt="" src="/spice-mark.svg" />
        <span>SPICE<small>MUST FLOW</small></span>
      </header>
      <section className="auth-copy" aria-busy={checking || submitting}>
        <h1>Your market.<br /><em>In motion.</em></h1>
        <p>Private options intelligence, live positions, and an agent that can act when you say so.</p>
        {checking ? (
          <div className="auth-checking" role="status"><span />Checking your session</div>
        ) : error ? (
          <div className="auth-error" role="alert">
            <span>{error}</span>
            <button onClick={() => window.location.reload()} type="button">Try again</button>
          </div>
        ) : (
          <>
            <button className="google-sign-in" disabled={submitting} onClick={() => void beginSignIn()} type="button">
              <GoogleMark />
              <span>{submitting ? 'Opening Google…' : 'Continue with Google'}</span>
            </button>
            {signInError && <p className="auth-inline-error" role="alert">{signInError}</p>}
          </>
        )}
      </section>
      <footer className="auth-footer">
        <span>Private workspace</span>
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
