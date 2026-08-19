import { vi } from 'vitest'

import { type BrokerApi } from '../src/server/tastytrade'

/**
 * A broker whose every call is a recorded fake, standing in for the live Tastytrade
 * API. Install it with `setBrokerApi` in `beforeEach` and undo it with `resetBrokerApi`
 * in `afterEach`; `satisfies BrokerApi` keeps the stub in step with the real contract.
 */
export function stubBroker() {
  return {
    loadEquityCandleFromTime: vi.fn(),
    loadMarketSnapshot: vi.fn(),
    loadQuoteToken: vi.fn(),
    resolveAccountNumber: vi.fn(),
    tastyRequest: vi.fn(),
  } satisfies BrokerApi
}
