import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrokerageSubmissionUnknownError } from '../src/server/brokerage'
import { BrokerCredentialMissingError } from '../src/server/broker-credential'
import { BrokerCancellationAmbiguousError, resetBrokerAdapters, setBrokerAdapters } from '../src/server/brokers'
import { cancelBrokerageOrder, placeBrokerageOrder } from '../src/server/order-placement'
import { PortfolioRiskError } from '../src/server/portfolio-risk'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { resetInternalWatchlistWriter, setInternalWatchlistWriter } from '../src/server/internal-watchlist'
import { resetTradeGuards, setTradeGuards } from '../src/server/trade-guards'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { brokerCredential, stubAdapter, stubBroker, STUB_BROKER_ID, stubBrokerCredential } from './broker-stub'

afterEach(() => {
  resetBrokerApi()
  resetInternalWatchlistWriter()
  resetTradeGuards()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const EQUITY_ORDER = {
  action: 'Buy to Open' as const,
  kind: 'place_equity_order' as const,
  limitPrice: 700,
  priceEffect: 'Debit' as const,
  quantity: 1,
  symbol: 'SPY',
}

const ACCEPTED_ORDER_RESPONSE = {
  data: {
    'buying-power-effect': { effect: 'Debit' },
    order: {
      id: 123,
      legs: [{ action: 'Buy to Open', 'instrument-type': 'Equity', quantity: 1, symbol: 'SPY' }],
      'order-type': 'Limit',
      price: '700.00',
      'time-in-force': 'Day',
    },
    warnings: [],
  },
}

function allowingGuards() {
  setTradeGuards({
    assertOrderMarketSafe: async () => ({ ask: 700, bid: 699, observedAt: new Date().toISOString(), tickSize: 0.01 }),
    assertPortfolioActionAllowed: async () => ({ allowed: true, floor: 0, maxLoss: 700, remainingLossBudget: 1_000 }),
  })
}

/**
 * A D1 double that records writes and answers the quarantine lookup from an in-memory row,
 * so a test can assert on what the placement path actually persisted.
 */
function quarantineDatabase(existing: { account_number: string; broker_id: string } | undefined) {
  const inserts: unknown[][] = []
  const accepted: unknown[][] = []
  const db: D1Database = {
    ...unsupportedDatabase(),
    prepare: (sql: string) => ({
      ...unsupportedStatement(),
      bind: (...values: unknown[]) => ({
        ...unsupportedStatement(),
        first: async () => {
          if (!sql.includes('FROM broker_submissions')) throw new Error(`Unexpected first query: ${sql}`)
          const [broker, account] = values
          if (!existing || existing.broker_id !== broker || existing.account_number !== account) return null
          return { id: 'quarantined-1', payload_json: JSON.stringify(EQUITY_ORDER), submitted_at: new Date().toISOString() }
        },
        run: async () => {
          if (!sql.includes('INSERT INTO broker_submissions')) throw new Error(`Unexpected run query: ${sql}`)
          // Only the quarantine write is under test here; the accepted-submission record is
          // asserted separately so a test cannot pass by conflating the two.
          if (sql.includes("'unresolved'")) inserts.push(values)
          else accepted.push(values)
          return d1Result([], 1)
        },
      }),
    }),
  }
  return { accepted, db, inserts }
}

describe('brokerage order placement', () => {
  it('refuses without a broker credential before touching the store or the broker', async () => {
    const brokerage = stubBroker()
    setBrokerApi(brokerage)

    await expect(placeBrokerageOrder({ DB: quarantineDatabase(undefined).db }, EQUITY_ORDER, undefined))
      .rejects.toBeInstanceOf(BrokerCredentialMissingError)
    expect(brokerage.resolveAccountNumber).not.toHaveBeenCalled()
    expect(brokerage.tastyRequest).not.toHaveBeenCalled()
  })

  it('refuses while an ambiguous submission for that account is unresolved', async () => {
    const brokerage = stubBroker()
    brokerage.resolveAccountNumber.mockResolvedValue('TEST123')
    setBrokerApi(brokerage)
    setInternalWatchlistWriter({ ensureSymbols: async () => [] })
    allowingGuards()
    const { db } = quarantineDatabase({ account_number: 'TEST123', broker_id: 'tastytrade' })

    await expect(placeBrokerageOrder({ DB: db }, EQUITY_ORDER, brokerCredential))
      .rejects.toBeInstanceOf(PortfolioRiskError)
    // Nothing may reach the broker while the earlier submission is unaccounted for.
    expect(brokerage.tastyRequest).not.toHaveBeenCalled()
  })

  it('does not let one account quarantine block a different account', async () => {
    const brokerage = stubBroker()
    brokerage.resolveAccountNumber.mockResolvedValue('OTHER456')
    brokerage.tastyRequest
      .mockResolvedValueOnce(ACCEPTED_ORDER_RESPONSE)
      .mockResolvedValueOnce(ACCEPTED_ORDER_RESPONSE)
    setBrokerApi(brokerage)
    setInternalWatchlistWriter({ ensureSymbols: async () => [] })
    allowingGuards()
    // The unresolved row belongs to TEST123; the caller's credential resolves to OTHER456.
    const { db, inserts } = quarantineDatabase({ account_number: 'TEST123', broker_id: 'tastytrade' })

    await expect(placeBrokerageOrder({ DB: db }, EQUITY_ORDER, brokerCredential)).resolves.toMatchObject({ orderId: '123' })
    expect(inserts).toHaveLength(0)
  })

  it('writes no quarantine row when the broker accepts the order', async () => {
    const brokerage = stubBroker()
    brokerage.resolveAccountNumber.mockResolvedValue('TEST123')
    brokerage.tastyRequest
      .mockResolvedValueOnce(ACCEPTED_ORDER_RESPONSE)
      .mockResolvedValueOnce(ACCEPTED_ORDER_RESPONSE)
    setBrokerApi(brokerage)
    setInternalWatchlistWriter({ ensureSymbols: async () => [] })
    allowingGuards()
    const { accepted, db, inserts } = quarantineDatabase(undefined)

    await expect(placeBrokerageOrder({ DB: db }, EQUITY_ORDER, brokerCredential)).resolves.toMatchObject({ orderId: '123' })
    expect(inserts).toHaveLength(0)
    // The accepted order is still recorded: a later price-only replacement resolves the
    // original order's shape from this row before the broker is asked to echo it.
    expect(accepted).toHaveLength(1)
    expect(accepted[0]?.at(-1)).toBe('123')
  })

  it('quarantines the account when a submission becomes ambiguous', async () => {
    const brokerage = stubBroker()
    brokerage.resolveAccountNumber.mockResolvedValue('TEST123')
    brokerage.tastyRequest
      .mockResolvedValueOnce(ACCEPTED_ORDER_RESPONSE)
      .mockRejectedValueOnce(new TypeError('fetch failed'))
    setBrokerApi(brokerage)
    setInternalWatchlistWriter({ ensureSymbols: async () => [] })
    allowingGuards()
    const { db, inserts } = quarantineDatabase(undefined)

    await expect(placeBrokerageOrder({ DB: db }, EQUITY_ORDER, brokerCredential))
      .rejects.toBeInstanceOf(BrokerageSubmissionUnknownError)
    expect(inserts).toHaveLength(1)
    const [, broker, account, payloadJson] = inserts[0]!
    expect(broker).toBe('tastytrade')
    expect(account).toBe('TEST123')
    // The server-resolved order, not the caller's: reconciliation fingerprints against this.
    expect(JSON.parse(String(payloadJson))).toMatchObject({ kind: 'place_equity_order', symbol: 'SPY' })
  })

  it('preserves submission ambiguity when the quarantine row cannot be recorded', async () => {
    const brokerage = stubBroker()
    brokerage.resolveAccountNumber.mockResolvedValue('TEST123')
    brokerage.tastyRequest
      .mockResolvedValueOnce(ACCEPTED_ORDER_RESPONSE)
      .mockRejectedValueOnce(new TypeError('fetch failed'))
    setBrokerApi(brokerage)
    setInternalWatchlistWriter({ ensureSymbols: async () => [] })
    allowingGuards()
    const db: D1Database = {
      ...unsupportedDatabase(),
      prepare: (sql: string) => ({
        ...unsupportedStatement(),
        bind: () => ({
          ...unsupportedStatement(),
          first: async () => null,
          run: async () => {
            if (sql.includes('INSERT INTO broker_submissions')) throw new Error('D1 persistence unavailable')
            throw new Error(`Unexpected run query: ${sql}`)
          },
        }),
      }),
    }
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    // A failed quarantine write must never downgrade an ambiguous broker outcome into a
    // plain failure: the caller still has to treat the order as possibly live.
    await expect(placeBrokerageOrder({ DB: db }, EQUITY_ORDER, brokerCredential))
      .rejects.toBeInstanceOf(BrokerageSubmissionUnknownError)
    expect(errorLog).toHaveBeenCalledWith('BrokerageQuarantinePersistenceFailed')
  })

  it('refuses a rejected portfolio guard before any broker submission', async () => {
    const brokerage = stubBroker()
    brokerage.resolveAccountNumber.mockResolvedValue('TEST123')
    brokerage.tastyRequest.mockResolvedValue(ACCEPTED_ORDER_RESPONSE)
    setBrokerApi(brokerage)
    setInternalWatchlistWriter({ ensureSymbols: async () => [] })
    setTradeGuards({
      assertOrderMarketSafe: async () => ({ ask: 700, bid: 699, observedAt: new Date().toISOString(), tickSize: 0.01 }),
      assertPortfolioActionAllowed: async () => { throw new PortfolioRiskError('Maximum order loss exceeds the remaining budget.') },
    })
    const { db, inserts } = quarantineDatabase(undefined)

    await expect(placeBrokerageOrder({ DB: db }, EQUITY_ORDER, brokerCredential))
      .rejects.toThrow('Maximum order loss')
    expect(brokerage.tastyRequest).not.toHaveBeenCalled()
    expect(inserts).toHaveLength(0)
  })
})

describe('cancelling a working order', () => {
  it('cancels through the adapter for the account the credential resolves to', async () => {
    const cancelled: Array<{ account: string; orderId: string }> = []
    setBrokerAdapters({
      [STUB_BROKER_ID]: {
        ...stubAdapter(),
        cancelOrder: async (_env, ref, orderId) => { cancelled.push({ account: ref.accountNumber, orderId }) },
      },
    })

    await expect(cancelBrokerageOrder({}, '12345', stubBrokerCredential))
      .resolves.toMatchObject({ cancelled: '12345' })
    expect(cancelled).toEqual([{ account: 'STUB-1', orderId: '12345' }])
    resetBrokerAdapters()
  })

  it('refuses without a broker credential rather than choosing an account', async () => {
    await expect(cancelBrokerageOrder({}, '12345', undefined))
      .rejects.toBeInstanceOf(BrokerCredentialMissingError)
  })

  it('surfaces an ambiguous cancellation instead of retrying it', async () => {
    setBrokerAdapters({
      [STUB_BROKER_ID]: {
        ...stubAdapter(),
        cancelOrder: async () => { throw new BrokerCancellationAmbiguousError() },
      },
    })
    // The order may or may not still be working. Anything that looks like success here would
    // let the next placement through on a false reading of the account.
    await expect(cancelBrokerageOrder({}, '12345', stubBrokerCredential))
      .rejects.toBeInstanceOf(BrokerCancellationAmbiguousError)
    resetBrokerAdapters()
  })
})
