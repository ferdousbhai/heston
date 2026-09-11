import { type BrokerAccountSnapshot, type BrokerId } from '../domain/broker'
import { brokerAdapterFor } from './brokers'
import { type BrokerCredential } from './broker-credential'
import { type AppEnv } from './env'

/**
 * One broker account as the rest of the server sees it: the provider-neutral snapshot plus
 * the account it came from. Nothing above this line knows which brokerage answered beyond
 * the `source` label.
 */
export type BrokerageContext = BrokerAccountSnapshot & {
  accountNumber: string
  source: BrokerId
}

export async function loadBrokerageContext(
  env: AppEnv,
  credential?: BrokerCredential,
): Promise<BrokerageContext> {
  const adapter = brokerAdapterFor(credential)
  const ref = await adapter.resolveAccountRef(env, credential)
  const snapshot = await adapter.loadAccountSnapshot(env, ref, credential)
  return { ...snapshot, accountNumber: ref.accountNumber, source: ref.broker }
}
