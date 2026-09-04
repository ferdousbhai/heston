import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type BrokerAccountHistoryPage,
  type BrokerAccountRef,
  type BrokerAccountSnapshot,
  type BrokerOrderHistoryPage,
  type BrokerOrderRecord,
} from '../src/domain/broker'
import {
  brokerAdapterFor,
  resetBrokerAdapters,
  setBrokerAdapters,
  UnknownBrokerError,
  type BrokerAdapter,
} from '../src/server/brokers'
import { tastytradeAdapter } from '../src/server/brokers/tastytrade'
import { loadBrokerageContext } from '../src/server/brokerage-context'
import { readAccountHistory } from '../src/server/brokerage-read-tools'
import { assertPortfolioActionAllowed } from '../src/server/portfolio-risk'
import { resetBrokerApi, setBrokerApi, type BrokerApi } from '../src/server/tastytrade'
import {
  brokerCredential,
  STUB_BROKER_ID,
  stubBrokerCredential,
} from './broker-stub'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'

function highWaterDb(value: number): D1Database {
  const statement = {
    ...unsupportedStatement(),
    bind: (): D1PreparedStatement => statement,
    run: async () => d1Result([], 1),
    first: async () => ({ high_water_nlv: value }),
  }
  return { ...unsupportedDatabase(), prepare: vi.fn(() => statement) }
}

/**
 * Every tastytrade entry point, wired to fail. Installed for the stub-adapter run so the seam
 * is proven real rather than nominal: if any account read still reaches provider code, the
 * test fails instead of quietly passing through it.
 */
const forbidden = () => { throw new Error('tastytrade transport reached') }

const forbiddenBrokerApi = {
  claimMarketRefresh: forbidden,
  loadMarketSnapshot: forbidden,
  loadPublicMarketSnapshot: forbidden,
  loadQuoteToken: forbidden,
  loadStoredMarketSnapshot: forbidden,
  loadStoredPublicMarketSnapshot: forbidden,
  lookupPublicMarketSymbol: forbidden,
  lookupStoredMarketSymbol: forbidden,
  resolveAccountNumber: forbidden,
  resolveResearchInstrumentCatalogFromTastytrade: forbidden,
  tastyRequest: forbidden,
  withBrokerMutationLease: forbidden,
} satisfies BrokerApi

const snapshot: BrokerAccountSnapshot = {
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

const historyPage: BrokerAccountHistoryPage = {
  items: [{
    id: '7',
    occurredAt: '2026-09-02T14:30:00.000Z',
    transactionType: 'Trade',
  }],
  rowCount: 1,
  totalItemCount: 1,
}

function stubAdapter(): BrokerAdapter & { calls: string[] } {
  const calls: string[] = []
  const ref: BrokerAccountRef = { accountNumber: 'STUB-1', broker: STUB_BROKER_ID }
  return {
    calls,
    id: STUB_BROKER_ID,
    cancelOrder: async () => { calls.push('cancelOrder') },
    loadAccountSnapshot: async (): Promise<BrokerAccountSnapshot> => {
      calls.push('loadAccountSnapshot')
      return snapshot
    },
    readAccountHistory: async (): Promise<BrokerAccountHistoryPage> => {
      calls.push('readAccountHistory')
      return historyPage
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

describe('broker adapter seam', () => {
  let adapter: ReturnType<typeof stubAdapter>

  beforeEach(() => {
    adapter = stubAdapter()
    setBrokerAdapters({ [STUB_BROKER_ID]: adapter })
    setBrokerApi(forbiddenBrokerApi)
  })

  afterEach(() => {
    resetBrokerAdapters()
    resetBrokerApi()
  })

  it('drives the account context, the portfolio guard, and the read tools with no provider code in the path', async () => {
    const context = await loadBrokerageContext({}, stubBrokerCredential)
    expect(context).toMatchObject({
      accountNumber: 'STUB-1',
      source: STUB_BROKER_ID,
      balances: { netLiquidatingValue: 100_000 },
      positions: [{ symbol: 'SPY' }],
    })

    const assessment = await assertPortfolioActionAllowed({ DB: highWaterDb(100_000) }, {
      kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open',
      quantity: 1, limitPrice: 700, priceEffect: 'Debit',
    }, stubBrokerCredential)
    expect(assessment).toMatchObject({ allowed: true, maxLoss: 700 })

    const history = await readAccountHistory({}, { type: 'transactions' }, stubBrokerCredential)
    expect(history).toMatchObject({ source: STUB_BROKER_ID, totalItemCount: 1, truncated: false })
    expect(history.items).toHaveLength(1)

    expect(adapter.calls).toEqual([
      'resolveAccountRef',
      'loadAccountSnapshot',
      'resolveAccountRef',
      'loadAccountSnapshot',
      'resolveAccountRef',
      'readAccountHistory',
    ])
  })

  it('fails closed on a broker id no adapter is registered for', async () => {
    expect(() => brokerAdapterFor(brokerCredential)).toThrow(UnknownBrokerError)
    await expect(loadBrokerageContext({}, brokerCredential))
      .rejects.toThrow("No broker adapter is registered for 'tastytrade'.")
    expect(adapter.calls).toEqual([])
  })

  it('fails closed rather than choosing a broker when no credential is presented', async () => {
    await expect(loadBrokerageContext({})).rejects.toThrow('No brokerage is connected for this request.')
    expect(adapter.calls).toEqual([])
  })
})

describe('registered adapters', () => {
  it('routes a tastytrade credential to the tastytrade adapter', () => {
    expect(brokerAdapterFor(brokerCredential)).toBe(tastytradeAdapter)
    expect(tastytradeAdapter.id).toBe('tastytrade')
  })
})
