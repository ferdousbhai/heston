/**
 * When the proxy stops handing out a cached broker access token.
 *
 * Refreshed on a margin rather than on a 401, so a placement is never attempted with a token that
 * dies mid-flight. A token is handed to one forwarded request, which the proxy abandons after
 * `upstreamTimeoutMs`; retiring it that long before expiry means every request it rides on
 * finishes, or is abandoned, while it is still live. A tenth of the lifetime caps the margin for a
 * token too short-lived to spare a whole timeout and still be worth caching. This is the rule the
 * Worker applies to its own market credential, with this process's timeout in place of its own.
 */
export const REFRESH_SKEW_FRACTION = 0.1

export function tokenRetiresAt(issuedAtMs, lifetimeMs, upstreamTimeoutMs) {
  const skewMs = Math.min(upstreamTimeoutMs, lifetimeMs * REFRESH_SKEW_FRACTION)
  return issuedAtMs + lifetimeMs - skewMs
}
