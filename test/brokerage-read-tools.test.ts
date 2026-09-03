import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { brokerCredential, stubBroker } from './broker-stub'
import {
  createBrokerageReadTools,
  findOptionContracts,
  readAccountHistory,
  readMarketMetrics,
  readMarketStatus,
  readInstrumentQuotes,
  searchSymbols,
} from '../src/server/brokerage-read-tools'

const tastytrade = stubBroker()

beforeEach(() => setBrokerApi(tastytrade))
afterEach(() => resetBrokerApi())

const now = new Date('2026-08-13T12:00:00.000Z')

describe('brokerage read tools', () => {
  beforeEach(() => {
    tastytrade.resolveAccountNumber.mockReset().mockResolvedValue('PRIVATE123')
    tastytrade.tastyRequest.mockReset()
  })

  it('exposes only the bounded read tool factories', () => {
    expect(createBrokerageReadTools({}).map((tool) => tool.name)).toEqual([
      'read_account_history',
      'search_symbols',
    ])
  })

  it('normalizes transaction history, strips account number, and reports pagination', async () => {
    tastytrade.tastyRequest.mockResolvedValue({
      data: {
        items: [{
          id: 42,
          'account-number': 'PRIVATE123',
          action: 'Buy to Open',
          'executed-at': '2026-08-12T14:30:00.000Z',
          'instrument-type': 'Equity Option',
          'net-value': '315.50',
          'net-value-effect': 'Debit',
          'order-id': 99,
          price: '3.15',
          quantity: '1',
          symbol: 'AAPL  260918C00200000',
          'transaction-sub-type': 'Buy',
          'transaction-type': 'Trade',
          'underlying-symbol': 'AAPL',
        }],
      },
      pagination: { 'total-items': 3 },
    })

    const result = await readAccountHistory({}, {
      days: 30,
      limit: 1,
      pageOffset: 0,
      transactionType: 'Trade',
      type: 'transactions',
      underlyingSymbol: 'AAPL',
    }, brokerCredential, now)

    expect(tastytrade.tastyRequest).toHaveBeenCalledWith(
      {},
      '/accounts/PRIVATE123/transactions?page-offset=0&per-page=1&sort=Desc&start-date=2026-07-14&underlying-symbol=AAPL&type=Trade',
      {},
      brokerCredential,
    )
    expect(result).toMatchObject({
      asOf: now.toISOString(),
      totalItemCount: 3,
      truncated: true,
    })
    expect(result.items[0]).toEqual({
      action: 'Buy to Open',
      id: '42',
      instrumentType: 'Equity Option',
      netValue: -315.5,
      occurredAt: '2026-08-12T14:30:00.000Z',
      orderId: '99',
      price: 3.15,
      quantity: 1,
      symbol: 'AAPL  260918C00200000',
      transactionSubType: 'Buy',
      transactionType: 'Trade',
      underlyingSymbol: 'AAPL',
      value: undefined,
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE123')
  })

  it('redacts account identity from broker history errors', async () => {
    tastytrade.tastyRequest.mockRejectedValue(new Error('TastytradeApi:500:/accounts/PRIVATE123/transactions'))
    await expect(readAccountHistory({}, { type: 'transactions' }, brokerCredential, now)).rejects.toThrow('transactions are unavailable')
    try {
      await readAccountHistory({}, { type: 'transactions' }, brokerCredential, now)
    } catch (error) {
      expect(String(error)).not.toContain('PRIVATE123')
    }
  })

  it('allows pagination to continue until the broker reports completion', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [] }, pagination: { 'total-items': 0 } })

    await expect(readAccountHistory({}, {
      days: 366,
      pageOffset: 1_001,
      type: 'orders',
    }, brokerCredential, now)).resolves.toMatchObject({ pageOffset: 1_001, truncated: false })
    expect(tastytrade.tastyRequest).toHaveBeenCalledWith(
      {},
      '/accounts/PRIVATE123/orders?page-offset=1001&per-page=25&sort=Desc&start-date=2025-08-12',
      {},
      brokerCredential,
    )
  })

  it('rejects order-only transaction filters and malformed history envelopes', async () => {
    await expect(readAccountHistory({}, {
      transactionType: 'Trade',
      type: 'orders',
    }, brokerCredential, now)).rejects.toThrow('valid only for transaction history')
    expect(tastytrade.resolveAccountNumber).not.toHaveBeenCalled()

    tastytrade.tastyRequest.mockResolvedValue({ data: {} })
    await expect(readAccountHistory({}, { type: 'transactions' }, brokerCredential, now)).rejects.toThrow('invalid response')
  })

  it('returns compact metrics in request order with explicit missing symbols', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [{
      symbol: 'NVDA',
      beta: '1.7',
      'earnings-per-share': '4.20',
      'historical-volatility-30-day': '42',
      'implied-volatility-30-day': '0.51',
      'implied-volatility-index': '0.49',
      'implied-volatility-index-rank': '0.72',
      'implied-volatility-percentile': '0.81',
      'iv-hv-30-day-difference': '9',
      'liquidity-rank': '0.98',
      'liquidity-rating': 5,
      'liquidity-value': '12.5',
      'market-cap': '3000000000000',
      'price-earnings-ratio': '35.4',
      'updated-at': '2026-08-13T11:55:00.000Z',
      earnings: {
        estimated: true,
        'expected-report-date': '2026-08-26',
        'time-of-day': 'After Market',
      },
    }] } })

    const result = await readMarketMetrics({}, ['NVDA', 'AAPL', 'NVDA'], now)

    expect(tastytrade.tastyRequest).toHaveBeenCalledWith({}, '/market-metrics?symbols=NVDA,AAPL')
    expect(result).toMatchObject({
      asOf: now.toISOString(),
      missingSymbols: ['AAPL'],
      volatilityUnit: 'percentage_points',
    })
    expect(result.metrics).toEqual([expect.objectContaining({
      earningsDate: '2026-08-26',
      historicalVolatility30Day: 42,
      impliedHistoricalVolatility30DayDifference: 9,
      impliedVolatility30Day: 51,
      impliedVolatilityRank: 72,
      liquidityRating: 5,
      marketCap: 3_000_000_000_000,
      symbol: 'NVDA',
    })])
  })

  it('leaves the capitalization tastytrade reports as zero out of the row', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [{
      symbol: 'TQQQ',
      'market-cap': '0.0',
      'updated-at': '2026-08-13T11:55:00.000Z',
    }] } })

    const result = await readMarketMetrics({}, ['TQQQ'], now)

    expect(result.metrics[0]?.marketCap).toBeUndefined()
  })

  it('fails closed on duplicate or malformed market metrics', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [
      { symbol: 'NVDA' },
      { symbol: 'NVDA' },
    ] } })
    await expect(readMarketMetrics({}, ['NVDA'], now)).rejects.toThrow('invalid response')
  })

  it('normalizes the current equity session', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: {
      state: 'Open',
      'instrument-collection': 'Equity',
      'open-at': '2026-08-13T13:30:00.000Z',
      'close-at': '2026-08-13T20:00:00.000Z',
      'close-at-ext': '2026-08-14T00:00:00.000Z',
      'next-session': { 'open-at': '2026-08-14T13:30:00.000Z' },
      'previous-session': { 'close-at': '2026-08-12T20:00:00.000Z' },
    } })

    await expect(readMarketStatus({}, now)).resolves.toEqual({
      asOf: now.toISOString(),
      closesAt: '2026-08-13T20:00:00.000Z',
      extendedClosesAt: '2026-08-14T00:00:00.000Z',
      instrumentCollection: 'Equity',
      nextOpenAt: '2026-08-14T13:30:00.000Z',
      opensAt: '2026-08-13T13:30:00.000Z',
      previousCloseAt: '2026-08-12T20:00:00.000Z',
      source: 'tastytrade',
      startsAt: undefined,
      state: 'Open',
    })
  })

  it('bounds and compacts symbol search results', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [
      { symbol: 'AAPL', description: 'Apple Inc.', options: true, 'instrument-type': 'Equity', 'listed-market': 'NASDAQ' },
      { symbol: 'AAP', description: 'Advance Auto Parts', options: true, 'instrument-type': 'Equity' },
    ] } })

    const result = await searchSymbols({}, 'Apple', 1, now)

    expect(tastytrade.tastyRequest).toHaveBeenCalledWith({}, '/symbols/search/Apple')
    expect(result).toMatchObject({ totalResultCount: 2, truncated: true })
    expect(result.results).toEqual([{
      description: 'Apple Inc.',
      hasOptions: true,
      instrumentType: 'Equity',
      listedMarket: 'NASDAQ',
      symbol: 'AAPL',
    }])
  })

  it('finds only exact active Standard option contracts and preserves broker identity fields', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [
      {
        active: true,
        'expiration-date': '2026-09-18',
        'instrument-type': 'Equity Option',
        'is-closing-only': false,
        'option-chain-type': 'Standard',
        'option-type': 'C',
        'root-symbol': 'AAPL',
        'shares-per-contract': 100,
        'streamer-symbol': '.AAPL260918C200',
        'strike-price': '200',
        symbol: 'AAPL  260918C00200000',
        'underlying-symbol': 'AAPL',
      },
      {
        active: false,
        'expiration-date': '2026-09-18',
        'instrument-type': 'Equity Option',
        'option-chain-type': 'Standard',
        'option-type': 'C',
        'root-symbol': 'AAPL',
        'shares-per-contract': 100,
        'strike-price': '200',
        symbol: 'INACTIVE',
        'underlying-symbol': 'AAPL',
      },
      {
        active: true,
        'expiration-date': '2026-09-18',
        'instrument-type': 'Equity Option',
        'option-chain-type': 'Non-standard',
        'option-type': 'C',
        'root-symbol': 'AAPL',
        'shares-per-contract': 150,
        'strike-price': '200',
        symbol: 'ADJUSTED',
        'underlying-symbol': 'AAPL',
      },
    ] } })

    const result = await findOptionContracts({}, {
      expiry: '2026-09-18', optionType: 'C', strike: 200, underlying: 'AAPL',
    }, now)

    expect(tastytrade.tastyRequest).toHaveBeenCalledWith({}, '/option-chains/AAPL')
    expect(result).toMatchObject({
      mode: 'contracts',
      truncated: false,
    })
    if (result.mode !== 'contracts') throw new Error('Expected contract mode')
    expect(result.contracts).toEqual([{
      expirationDate: '2026-09-18',
      isClosingOnly: false,
      optionType: 'C',
      sharesPerContract: 100,
      streamerSymbol: '.AAPL260918C200',
      strikePrice: 200,
      symbol: 'AAPL  260918C00200000',
    }])
  })

  it('returns listed contracts nearest a target strike', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [180, 200, 220].map((strike) => ({
      active: true,
      'expiration-date': '2026-09-18',
      'instrument-type': 'Equity Option',
      'is-closing-only': false,
      'option-chain-type': 'Standard',
      'option-type': 'C',
      'shares-per-contract': 100,
      'strike-price': String(strike),
      symbol: `AAPL ${strike}`,
      'underlying-symbol': 'AAPL',
    })) } })

    const result = await findOptionContracts({}, {
      expiry: '2026-09-18', nearStrike: 205, optionType: 'C', underlying: 'AAPL',
    }, now)

    if (result.mode !== 'contracts') throw new Error('Expected contract mode')
    expect(result.contracts.map((contract) => contract.strikePrice)).toEqual([200, 220, 180])
  })

  it('rejects malformed option rows instead of silently returning an empty chain', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [{
      active: true,
      'instrument-type': 'Equity Option',
      'option-chain-type': 'Standard',
      'option-type': 'C',
      'underlying-symbol': 'AAPL',
    }] } })

    await expect(findOptionContracts({}, { underlying: 'AAPL' }, now)).rejects.toThrow('invalid response')
  })

  it('resolves an option tuple and returns a complete non-crossed exact quote', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path === '/option-chains/AAPL') return Promise.resolve({ data: { items: [{
        active: true, 'expiration-date': '2026-09-18', 'instrument-type': 'Equity Option',
        'is-closing-only': false, 'option-chain-type': 'Standard', 'option-type': 'C',
        'shares-per-contract': 100, 'strike-price': '200', symbol: 'AAPL  260918C00200000',
        'underlying-symbol': 'AAPL',
      }] } })
      if (path.startsWith('/market-data/by-type?')) return Promise.resolve({ data: { items: [{
        symbol: 'AAPL  260918C00200000', instrumentType: 'Equity Option',
        bid: 3.1, ask: 3.3, bidSize: 12, askSize: 9, updatedAt: '2026-08-13T11:59:59.000Z',
      }] } })
      throw new Error(`Unexpected path ${path}`)
    })

    const result = await readInstrumentQuotes({}, { contracts: [{
      underlying: 'AAPL', expiry: '2026-09-18', optionType: 'C', strike: 200,
    }] }, now)

    expect(result).toMatchObject({
      source: 'tastytrade-rest-market-data',
      quotes: [{ bid: 3.1, ask: 3.3, mid: 3.2, underlying: 'AAPL' }],
    })
    expect(tastytrade.tastyRequest).toHaveBeenCalledWith(
      {}, '/market-data/by-type?equity-option=AAPL%20%20260918C00200000',
    )
  })

  it('rejects missing or crossed quotes', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [{
      symbol: 'AAPL', instrumentType: 'Equity', bid: 200, ask: 199,
      updatedAt: '2026-08-13T11:59:59.000Z',
    }] } })
    await expect(readInstrumentQuotes({}, { symbols: ['AAPL'] }, now)).rejects.toThrow('invalid response')
  })
})
