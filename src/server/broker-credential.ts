import { OwnerVisibleError } from './owner-visible-error'

export type BrokerCredential = {
  /** Short-lived broker access token supplied per request. Never persisted, never logged. */
  accessToken: string
  /** Which broker issued it. Only 'tastytrade' exists today. */
  broker: 'tastytrade'
}

export class BrokerCredentialMissingError extends OwnerVisibleError {
  constructor() {
    super(
      'broker-credential',
      'No brokerage is connected for this request. Connect a brokerage from the Connect tab in the Spice web app, then try again.',
    )
    this.name = 'BrokerCredentialMissingError'
  }
}

export function brokerCredentialFromHeaders(headers: Headers): BrokerCredential | undefined {
  const broker = headers.get('X-Spice-Broker')
  const accessToken = headers.get('X-Spice-Broker-Token')?.trim()
  // This token is request-scoped and is never written to D1 or logged. An unknown broker id
  // is refused rather than defaulted, so it can never select the Worker's own credential.
  if (!broker?.trim() || broker !== 'tastytrade' || !accessToken) return undefined
  return { accessToken, broker }
}
