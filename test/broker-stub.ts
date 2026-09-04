import { vi } from 'vitest'

import { type AppEnv } from '../src/server/env'
import { type BrokerApi } from '../src/server/tastytrade'
import { type BrokerCredential } from '../src/server/broker-credential'
import {
  type BrokerAccountHistoryPage,
  type BrokerAccountRef,
  type BrokerAccountSnapshot,
  type BrokerOrderHistoryPage,
  type BrokerOrderRecord,
} from '../src/domain/broker'
import { type BrokerAdapter } from '../src/server/brokers'
import { type BrokerId } from '../src/domain/broker'
import {
  type MarketSnapshot,
  type PublicMarketSnapshot,
  type PublicSymbolLookup,
} from '../src/domain/market'

export const brokerCredential = {
  accessToken: 'member-access-token',
  broker: 'tastytrade',
} satisfies BrokerCredential

/**
 * A broker id no adapter is registered for in production. The cast is deliberate: `BrokerId`
 * is the production union, and a test that registers a stub adapter is the only thing allowed
 * to name an id outside it.
 */
const stubBrokerName: string = 'stub-broker'
// SAFETY: no adapter is registered for this id in production, which is exactly the point —
// the widening is what lets a test register one and prove the lookup is not hard-wired.
const stubBrokerId = stubBrokerName as BrokerId

export const STUB_BROKER_ID = stubBrokerId

export const stubBrokerCredential = {
  accessToken: 'stub-access-token',
  broker: STUB_BROKER_ID,
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

const stubSnapshot: BrokerAccountSnapshot = {
  asOf: '2026-09-03T13:00:00.000Z',
  balances: {
    availableTradingFunds: 64_000,
    cashAvailableToWithdraw: 65_000,
    cashBalance: 65_000,
    dayTradingBuyingPower: 256_000,
    derivativeBuyingPower: 64_000,
    equityBuyingPower: 128_000,
    netLiquidatingValue: 100_000,
  },
  liveOrders: [],
  orders: [],
  positions: [{
    direction: 'Long', instrumentType: 'Equity', quantity: 10, symbol: 'SPY', underlying: 'SPY',
  }],
}

const stubHistoryPage: BrokerAccountHistoryPage = {
  items: [{
    id: '7',
    occurredAt: '2026-09-02T14:30:00.000Z',
    transactionType: 'Trade',
  }],
  rowCount: 1,
  totalItemCount: 1,
}

/** A whole broker that is not tastytrade, so a test can prove the seam rather than assert it. */
export function stubAdapter(): BrokerAdapter & { calls: string[] } {
  const calls: string[] = []
  const ref: BrokerAccountRef = { accountNumber: 'STUB-1', broker: STUB_BROKER_ID }
  return {
    calls,
    id: STUB_BROKER_ID,
    cancelOrder: async () => { calls.push('cancelOrder') },
    loadAccountSnapshot: async (): Promise<BrokerAccountSnapshot> => {
      calls.push('loadAccountSnapshot')
      return stubSnapshot
    },
    readAccountHistory: async (): Promise<BrokerAccountHistoryPage> => {
      calls.push('readAccountHistory')
      return stubHistoryPage
    },
    readOrder: async (): Promise<BrokerOrderRecord> => {
      calls.push('readOrder')
      return { editable: false }
    },
    readOrderHistory: async (): Promise<BrokerOrderHistoryPage> => {
      calls.push('readOrderHistory')
      return { complete: true, orders: [] }
    },
    readPositionSymbols: async () => {
      calls.push('readPositionSymbols')
      return []
    },
    resolveAccountRef: async (): Promise<BrokerAccountRef> => {
      calls.push('resolveAccountRef')
      return ref
    },
  }
}
