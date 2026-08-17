export type ResearchProviderErrorCode = 'invalid-response' | 'unavailable'

export type ResearchProviderName = 'yahoo'

/** Research providers are contextual only; failures stay coded and never carry provider bodies or credentials. */
export class ResearchProviderError extends Error {
  constructor(
    public readonly code: ResearchProviderErrorCode,
    public readonly provider: ResearchProviderName,
  ) {
    super(`ResearchProvider:${provider}:${code}`)
    this.name = 'ResearchProviderError'
  }
}
