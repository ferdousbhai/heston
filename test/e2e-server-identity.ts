import { z } from 'zod'

/**
 * Refuse to run the suite against somebody else's dev server.
 *
 * `reuseExistingServer` adopts whatever already answers on the e2e port, and the readiness probe
 * is a bare status check -- so any unrelated project serving a 200 on `/api/health` is adopted
 * silently. That is not hypothetical: this suite spent a run asserting against a music app that
 * happened to hold port 3000, and every failure read as a bug in Heston.
 *
 * `/api/health` already says which service it is; nothing read it. This does, before any test.
 *
 * The two failure modes must not be conflated, which is the mistake the first version of this
 * made: a refused connection means nothing is listening and Playwright is about to start the real
 * server, while an answer that is not Heston's -- including HTML from an app whose SPA fallback
 * returns 200 for every path -- is the case worth stopping for.
 */
const IDENTITY_TIMEOUT_MS = 2_000

const HealthSchema = z.object({ service: z.string() })

export default async function assertServerIsHeston(): Promise<void> {
  const baseUrl = process.env.HESTON_E2E_BASE_URL
  if (!baseUrl) return

  let response: Response
  try {
    response = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(IDENTITY_TIMEOUT_MS) })
  } catch {
    // Nothing listening: Playwright starts its own server and there is nothing to guard against.
    return
  }
  // A server that answers but cannot say what it is will not be reused as Heston either, so this
  // is still the stop-worthy case rather than an unknown to wave through.
  const identity = HealthSchema.safeParse(await response.json().catch(() => undefined))
  if (identity.success && identity.data.service === 'heston') return

  const seen = identity.success ? identity.data.service : `${response.status} ${response.headers.get('content-type') ?? 'unknown'}`
  throw new Error(
    `${baseUrl} is already serving something that is not Heston (${seen}). Playwright would reuse `
    + 'it and every assertion would describe that app instead. Stop it, or set HESTON_E2E_PORT to '
    + 'a free port.',
  )
}
