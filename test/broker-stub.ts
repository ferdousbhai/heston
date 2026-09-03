import { vi } from 'vitest'

import { type AppEnv } from '../src/server/env'
import { type BrokerApi } from '../src/server/tastytrade'
import { type BrokerCredential } from '../src/server/broker-credential'
import {
  type MarketSnapshot,
  type PublicMarketSnapshot,
  type PublicSymbolLookup,
} from '../src/domain/market'

export const brokerCredential = {
  accessToken: 'member-access-token',
  broker: 'tastytrade',
} satisfies BrokerCredential

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
    loadMarketSnapshot: vi.fn(),
    loadPublicMarketSnapshot: vi.fn(),
    lookupPublicMarketSymbol: vi.fn<BrokerApi['lookupPublicMarketSymbol']>(async () => undefined),
    loadQuoteToken: vi.fn(),
    resolveResearchInstrumentCatalogFromTastytrade: vi.fn<BrokerApi['resolveResearchInstrumentCatalogFromTastytrade']>(async () => ({
      missingSymbols: [],
      receivedCount: 0,
      requestedCount: 0,
    })),
    resolveAccountNumber: vi.fn(),
    renewBrokerMutationLease,
    tastyRequest: vi.fn(),
    claimMarketRefresh: vi.fn(async () => true),
    lookupStoredMarketSymbol: vi.fn(async (): Promise<PublicSymbolLookup | undefined> => undefined),
    loadStoredMarketSnapshot: vi.fn(async (): Promise<MarketSnapshot | undefined> => undefined),
    loadStoredPublicMarketSnapshot: vi.fn(async (): Promise<PublicMarketSnapshot | undefined> => undefined),
    withBrokerMutationLease: vi.fn(async (_env, _accountNumber, operation) => operation({ renew: renewBrokerMutationLease })),
  } satisfies BrokerApi & { renewBrokerMutationLease: typeof renewBrokerMutationLease }
}
