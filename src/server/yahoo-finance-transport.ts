import { readBoundedText } from './bounded-response'

const MAX_YAHOO_RESPONSE_BYTES = 2_000_000
const YAHOO_TIMEOUT_MS = 12_000

/**
 * yahoo-finance2 buffers response bodies before it validates them. Enforce the
 * network boundary first, then give the library a reconstructed bounded body.
 */
export function boundedYahooFetch(fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const timeout = AbortSignal.timeout(YAHOO_TIMEOUT_MS)
    const signal = init?.signal ? AbortSignal.any([timeout, init.signal]) : timeout
    const response = await fetcher(input, { ...init, signal })
    const body = await readBoundedText(response, MAX_YAHOO_RESPONSE_BYTES, 'YahooFinance')
    const emptyBodyStatus = response.status === 101
      || response.status === 204
      || response.status === 205
      || response.status === 304
    return new Response(emptyBodyStatus ? null : body, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    })
  }
}
