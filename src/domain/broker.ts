import { z } from 'zod'

/**
 * Provider-neutral brokerage account vocabulary. Nothing here knows a REST path, a
 * provider field name, or a wire envelope: an adapter under `src/server/brokers/`
 * translates one broker into these shapes, and every account reader above the adapter
 * speaks only this file. Adding a broker adds an adapter, never a second vocabulary
 * for the same thing.
 */

/**
 * Every broker Spice can read an account from. Adding one means adding it here and
 * registering its adapter — the header parser and the registry both derive from this list,
 * so a new id cannot be half-added and silently accepted by one and refused by the other.
 */
export const BrokerIdSchema = z.enum(['tastytrade'])

export type BrokerId = z.infer<typeof BrokerIdSchema>

/** The one account a presented credential resolves to. */
export interface BrokerAccountRef {
  accountNumber: string
  broker: BrokerId
}

export interface BrokerBalances {
  availableTradingFunds: number
  cashAvailableToWithdraw: number
  cashBalance: number
  dayTradingBuyingPower: number
  derivativeBuyingPower: number
  equityBuyingPower: number
  netLiquidatingValue: number
}

export interface BrokerPosition {
  averageOpenPrice?: number
  direction: 'Long' | 'Short'
  expiresAt?: string
  instrumentType: string
  quantity: number
  symbol: string
  underlying: string
}

export interface BrokerOrderLeg {
  action: string
  instrumentType: string
  quantity: number
  symbol: string
}

export interface BrokerWorkingOrder {
  complexOrderId?: string
  id: string
  legs: BrokerOrderLeg[]
  price?: number
  priceEffect?: string
  status: string
  symbol: string
  timeInForce?: string
  type: string
}

/**
 * One live order row exactly as the broker listed it, before complex orders are expanded
 * into their child legs and duplicate ids are collapsed. The drawdown guard counts these
 * rather than `BrokerAccountSnapshot.orders`, because expansion can erase a complex order
 * whose children have all gone terminal while the order itself still occupies the account.
 */
export interface BrokerLiveOrderRow {
  /** The broker's own row id, stringified; empty when the row carried none. */
  id: string
  source: 'complex' | 'ordinary'
}

/**
 * The snapshot carries orders twice on purpose.
 *
 * `orders` expands complex orders into their legs and dedupes them, which is what a reader
 * wants. Expansion can erase a complex order whose children have all gone terminal while the
 * order itself still occupies the account. `liveOrders` is the rows as the broker listed them,
 * which is the only faithful answer to "is anything still working".
 */
export interface BrokerAccountSnapshot {
  asOf: string
  balances: BrokerBalances
  liveOrders: BrokerLiveOrderRow[]
  orders: BrokerWorkingOrder[]
  positions: BrokerPosition[]
}

/**
 * One order read back for a fingerprint comparison — a price-only replacement's echo check
 * and the ambiguous-submission reconciliation match. Every field is optional on purpose:
 * these two checks decide for themselves what a missing or unreadable field means (almost
 * always "not a match"), exactly as they did when they read the broker's JSON directly.
 * An adapter must not repair, default, or fail on a field here; it reports what it read.
 */
export interface BrokerOrderRecordLeg {
  action?: string
  /** Number of fills the broker reported, or undefined when it reported no readable fill list. */
  fillCount?: number
  instrumentType?: string
  quantity?: number
  remainingQuantity?: number
  symbol?: string
}

export interface BrokerOrderRecord {
  /** True only when the broker positively said the order is editable. */
  editable: boolean
  id?: string
  /** Undefined when the row carried no readable leg list; an entry is undefined when that leg was unreadable. */
  legs?: Array<BrokerOrderRecordLeg | undefined>
  orderType?: string
  price?: number
  priceEffect?: string
  receivedAt?: string
  replacesOrderId?: string
  status?: string
  terminalAt?: string
  timeInForce?: string
  updatedAt?: string
}

/**
 * One page of order history for reconciliation. `complete` is false whenever the page
 * could still be hiding rows, so an absent order stays ambiguous rather than concluding
 * the submission never reached the broker.
 */
export interface BrokerOrderHistoryPage {
  complete: boolean
  orders: BrokerOrderRecord[]
}

export interface BrokerHistoryOrderLeg {
  action: string
  instrumentType: string
  quantity: number
  remainingQuantity?: number
  symbol: string
}

export interface BrokerHistoryOrder {
  id: string
  legs: BrokerHistoryOrderLeg[]
  orderType: string
  price?: number
  priceEffect?: string
  receivedAt?: string
  rejectReason?: string
  size?: number
  status: string
  timeInForce: string
  underlyingInstrumentType: string
  underlyingSymbol: string
  updatedAt: string
}

export interface BrokerHistoryTransaction {
  action?: string
  id: string
  instrumentType?: string
  netValue?: number
  occurredAt: string
  orderId?: string
  price?: number
  quantity?: number
  symbol?: string
  transactionSubType?: string
  transactionType: string
  underlyingSymbol?: string
  value?: number
}

/**
 * One page of account history as the read tool asked for it. `rowCount` is how many rows
 * the broker actually returned before the tool's own display limit, which is what makes
 * truncation observable rather than a silently short list.
 */
export interface BrokerAccountHistoryPage {
  items: BrokerHistoryOrder[] | BrokerHistoryTransaction[]
  rowCount: number
  totalItemCount?: number
}
