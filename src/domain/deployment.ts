/**
 * Renamed from `X-Heston-Deployment-Id` with the move to spicy.trade, without sending both. A
 * bundle only reads this header on its own origin's responses, and every bundle that reads the
 * old name was served from heston.io, which now answers only with a cross-origin 308 its fetches
 * cannot follow. A response without the header reads as "not newer", so nothing reload-loops.
 */
export const SPICE_DEPLOYMENT_ID_HEADER = 'X-Spice-Deployment-Id'
const SPICE_DEPLOYMENT_QUERY_PARAMETER = 'app'

/**
 * How long a browser may reuse a public response. It lives here, beside the other contract
 * the Worker and the bundle share, because both sides read it: the Worker states it in
 * Cache-Control, and a visible tab polls on the same bound so each poll can see a new
 * observation rather than a copy the browser was still allowed to keep. A staleness budget, the
 * owner's choice rather than a provider figure: the snapshot is the delayed fallback beside the live
 * quote stream, so half a minute is fresh enough, and polling faster would only spend requests.
 */
export const PUBLIC_RESPONSE_MAX_AGE_SECONDS = 30

export function deploymentScopedPath(path: string, deploymentId: string): string {
  const url = new URL(path, 'https://spice.local')
  url.searchParams.set(SPICE_DEPLOYMENT_QUERY_PARAMETER, deploymentId)
  return `${url.pathname}${url.search}${url.hash}`
}
