import { assertOrderMarketSafe } from './order-market'
import { assertPortfolioActionAllowed } from './portfolio-risk'
import { defineSeam, type SeamValue } from './seam'

/**
 * The two pre-trade safety checks every placement path must clear. Order dispatch and
 * confirmation drafting call them through `tradeGuards()` so a test can install
 * stand-in guards with `setTradeGuards` instead of replacing their modules. Each entry
 * is the real check itself, so the contract type cannot drift from it.
 */
const tradeGuardSeam = defineSeam(() => ({ assertOrderMarketSafe, assertPortfolioActionAllowed }))

export type TradeGuards = SeamValue<typeof tradeGuardSeam>

/** The pre-trade guards currently in force. */
export const tradeGuards = tradeGuardSeam.current

/** Install stand-in guards for a test; pair every call with `resetTradeGuards()`. */
export const setTradeGuards = tradeGuardSeam.set

/** Restore the real pre-trade guards. */
export const resetTradeGuards = tradeGuardSeam.reset
