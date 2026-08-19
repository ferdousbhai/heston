import { assertOrderMarketSafe } from './order-market'
import { assertPortfolioActionAllowed } from './portfolio-risk'

/**
 * The two pre-trade safety checks every placement path must clear. Order dispatch and
 * confirmation drafting call them through `tradeGuards()` so a test can install
 * stand-in guards with `setTradeGuards` instead of replacing their modules. Each entry
 * is the real check itself, so the contract type cannot drift from it.
 */
function createTradeGuards() {
  return { assertOrderMarketSafe, assertPortfolioActionAllowed }
}

export type TradeGuards = ReturnType<typeof createTradeGuards>

let installedTradeGuards: TradeGuards = createTradeGuards()

/** The pre-trade guards currently in force. */
export function tradeGuards(): TradeGuards {
  return installedTradeGuards
}

/** Install stand-in guards for a test; pair every call with `resetTradeGuards()`. */
export function setTradeGuards(next: TradeGuards): void {
  installedTradeGuards = next
}

/** Restore the real pre-trade guards. */
export function resetTradeGuards(): void {
  installedTradeGuards = createTradeGuards()
}
