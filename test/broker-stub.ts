import { vi } from 'vitest'

import { type AppEnv } from '../src/server/env'
import { type BrokerApi } from '../src/server/tastytrade'

export function stubBrokerGate() {
  const gate = {
    acquire: vi.fn(async () => undefined),
    acquireMutation: vi.fn(async () => 'mutation-token'),
    renewMutation: vi.fn(async (_token: string) => undefined),
    releaseMutation: vi.fn(async (_token: string) => undefined),
  }
  const namespace = {
    getByName: vi.fn((_name: string) => gate),
  } satisfies NonNullable<AppEnv['BROKER_GATE']>
  return { gate, namespace }
}

export function stubBroker() {
  const renewBrokerMutationLease = vi.fn(async () => undefined)
  return {
    loadEquityCandleFromTime: vi.fn(),
    loadMarketSnapshot: vi.fn(),
    loadPublicMarketSnapshot: vi.fn(),
    loadQuoteToken: vi.fn(),
    resolveAccountNumber: vi.fn(),
    renewBrokerMutationLease,
    tastyRequest: vi.fn(),
    withBrokerMutationLease: vi.fn(async (_env, operation) => operation({ renew: renewBrokerMutationLease })),
  } satisfies BrokerApi & { renewBrokerMutationLease: typeof renewBrokerMutationLease }
}
