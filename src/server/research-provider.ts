import { CallerVisibleError } from './caller-visible-error'

export type ResearchProviderErrorCode = 'invalid-response' | 'unavailable'

export type ResearchProviderName = 'yahoo'

/** Research providers are contextual only; failures stay coded and never carry provider bodies or credentials. */
export class ResearchProviderError extends CallerVisibleError {
  constructor(
    public readonly code: ResearchProviderErrorCode,
    public readonly provider: ResearchProviderName,
  ) {
    super(`ResearchProvider:${provider}:${code}`)
    this.name = 'ResearchProviderError'
  }
}
