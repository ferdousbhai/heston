import { assertOrderMarketSafe } from './order-market'
import { assertPortfolioActionAllowed } from './portfolio-risk'
import { defineSeam, type SeamValue } from './seam'

const tradeGuardSeam = defineSeam(() => ({ assertOrderMarketSafe, assertPortfolioActionAllowed }))

export type TradeGuards = SeamValue<typeof tradeGuardSeam>

export const tradeGuards = tradeGuardSeam.current

export const setTradeGuards = tradeGuardSeam.set

export const resetTradeGuards = tradeGuardSeam.reset
