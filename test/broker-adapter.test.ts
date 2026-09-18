import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  brokerAdapterFor,
  resetBrokerAdapters,
  setBrokerAdapters,
  UnknownBrokerError,
} from '../src/server/brokers'
import { tastytradeAdapter } from '../src/server/brokers/tastytrade'
import { loadBrokerageContext } from '../src/server/brokerage-context'
import { readAccountHistory, readAccountSnapshot } from '../src/server/brokerage-read-tools'
import { assertPortfolioActionAllowed } from '../src/server/portfolio-risk'
import { resetBrokerApi, setBrokerApi, type BrokerApi } from '../src/server/tastytrade'
import {
  brokerCredential,
  STUB_BROKER_ID,
  stubBrokerCredential,
  stubAdapter,
} from './broker-stub'
import { highWaterDb } from './fake-d1'

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
  refreshPublicMarketSession: forbidden,
  lookupPublicMarketSymbol: forbidden,
  lookupStoredMarketSymbol: forbidden,
  resolveAccountNumber: forbidden,
  resolveResearchInstrumentCatalogFromTastytrade: forbidden,
  tastyRequest: forbidden,
  withBrokerMutationLease: forbidden,
} satisfies BrokerApi

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

    const snapshot = await readAccountSnapshot({}, {}, stubBrokerCredential)
    expect(snapshot).toMatchObject({
      source: STUB_BROKER_ID,
      balances: { netLiquidatingValue: 100_000 },
      positions: [{ symbol: 'SPY' }],
    })
    expect(JSON.stringify(snapshot)).not.toContain('STUB-1')

    expect(adapter.calls).toEqual([
      'resolveAccountRef',
      'loadAccountSnapshot',
      'resolveAccountRef',
      'loadAccountSnapshot',
      'resolveAccountRef',
      'readAccountHistory',
      'resolveAccountRef',
      'loadAccountSnapshot',
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
