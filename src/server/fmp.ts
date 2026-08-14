import { readBoundedText } from './bounded-response'
import { type AppEnv } from './env'
import { readSecret } from './secrets'

const FMP_API_BASE = 'https://financialmodelingprep.com/stable/'
const FMP_MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const FMP_TIMEOUT_MS = 12_000

export type ResearchProviderErrorCode =
  | 'authentication'
  | 'configuration'
  | 'invalid-response'
  | 'network'
  | 'rate-limit'
  | 'timeout'
  | 'unavailable'

export class ResearchProviderError extends Error {
  constructor(
    public readonly code: ResearchProviderErrorCode,
    public readonly provider: 'fmp',
    public readonly requestId?: string,
    public readonly status?: number,
  ) {
    super(`ResearchProvider:${provider}:${code}`)
    this.name = 'ResearchProviderError'
  }
}

export type FmpClient = {
  get(path: string, parameters: Readonly<Record<string, string>>): Promise<unknown>
}

function requestId(response: Response): string | undefined {
  return response.headers.get('x-request-id')
    ?? response.headers.get('request-id')
    ?? response.headers.get('cf-ray')
    ?? undefined
}

function responseError(response: Response): ResearchProviderError {
  const status = response.status
  const code: ResearchProviderErrorCode = status === 401 || status === 403
    ? 'authentication'
    : status === 429
      ? 'rate-limit'
      : status === 408 || status >= 500
        ? 'unavailable'
        : 'invalid-response'
  return new ResearchProviderError(code, 'fmp', requestId(response), status)
}

function providerErrorPayload(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return typeof record['Error Message'] === 'string' || typeof record.error === 'string'
}

/** Fixed-origin FMP client. Credentials stay in the header and never enter URLs or errors. */
export function createFmpClient(env: AppEnv, fetcher: typeof fetch = fetch): FmpClient {
  return {
    async get(path, parameters) {
      if (!path.startsWith('/') || path.includes('?') || path.includes('..')) {
        throw new ResearchProviderError('configuration', 'fmp')
      }
      let apiKey: string
      try {
        apiKey = await readSecret(env.FMP_API_KEY, 'FMP_API_KEY')
      } catch {
        throw new ResearchProviderError('configuration', 'fmp')
      }
      const url = new URL(path.slice(1), FMP_API_BASE)
      for (const [name, value] of Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right))) {
        url.searchParams.set(name, value)
      }

      let response: Response
      try {
        response = await fetcher(url, {
          headers: { Accept: 'application/json', apikey: apiKey },
          signal: AbortSignal.timeout(FMP_TIMEOUT_MS),
        })
      } catch (error) {
        const name = error instanceof Error ? error.name : ''
        throw new ResearchProviderError(
          name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network',
          'fmp',
        )
      }

      if (!response.ok) {
        await response.body?.cancel()
        throw responseError(response)
      }

      let payload: unknown
      try {
        payload = JSON.parse(await readBoundedText(response, FMP_MAX_RESPONSE_BYTES, 'FmpApi'))
      } catch (error) {
        if (error instanceof Error && error.message === 'FmpApi:response-too-large') {
          throw new ResearchProviderError('invalid-response', 'fmp', requestId(response), response.status)
        }
        throw new ResearchProviderError('invalid-response', 'fmp', requestId(response), response.status)
      }
      if (providerErrorPayload(payload)) {
        throw new ResearchProviderError('authentication', 'fmp', requestId(response), response.status)
      }
      return payload
    },
  }
}
