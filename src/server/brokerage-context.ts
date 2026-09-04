import { type BrokerAccountSnapshot, type BrokerId, type BrokerPosition } from '../domain/broker'
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

function agentPosition(position: BrokerPosition): BrokerPosition {
  const projected: BrokerPosition = {
    direction: position.direction,
    instrumentType: position.instrumentType,
    quantity: position.quantity,
    symbol: position.symbol,
    underlying: position.underlying,
  }
  if (position.averageOpenPrice !== undefined) projected.averageOpenPrice = position.averageOpenPrice
  if (position.expiresAt !== undefined) projected.expiresAt = position.expiresAt
  return projected
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

export function buildAgentRuntimeContext(context: BrokerageContext) {
  return {
    asOf: context.asOf,
    source: context.source,
    balances: {
      availableTradingFunds: context.balances.availableTradingFunds,
      cashAvailableToWithdraw: context.balances.cashAvailableToWithdraw,
      cashBalance: context.balances.cashBalance,
      dayTradingBuyingPower: context.balances.dayTradingBuyingPower,
      derivativeBuyingPower: context.balances.derivativeBuyingPower,
      equityBuyingPower: context.balances.equityBuyingPower,
      netLiquidatingValue: context.balances.netLiquidatingValue,
    },
    // Broker REST position marks are deprecated for P/L; exact live quotes belong in a market-data tool.
    positions: context.positions.map(agentPosition),
    orders: context.orders,
  }
}
