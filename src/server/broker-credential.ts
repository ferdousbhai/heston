import { BrokerIdSchema, type BrokerId } from '../domain/broker'
import { CallerVisibleError } from './caller-visible-error'

export type BrokerCredential = {
  /** Short-lived broker access token supplied per request. Never persisted, never logged. */
  accessToken: string
  /** Which broker issued it; it selects the adapter that may spend it. */
  broker: BrokerId
}

export class BrokerCredentialMissingError extends CallerVisibleError {
  constructor() {
    super(
      'No brokerage is connected for this request. Connect a brokerage from the Connect tab in the Heston web app, then try again.',
    )
    this.name = 'BrokerCredentialMissingError'
  }
}

export function brokerCredentialFromHeaders(headers: Headers): BrokerCredential | undefined {
  const accessToken = headers.get('X-Heston-Broker-Token')?.trim()
  // Parsed against the broker list rather than compared to a literal, so adding a broker is
  // its adapter plus its id and nothing here. This token is request-scoped and is never
  // written to D1 or logged; an unknown id is refused rather than defaulted, so it can never
  // select the Worker's own market-data credential.
  const broker = BrokerIdSchema.safeParse(headers.get('X-Heston-Broker')?.trim()).data
  if (!broker || !accessToken) return undefined
  return { accessToken, broker }
}
