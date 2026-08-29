const MAX_PORTFOLIO_DRAWDOWN = 0.40
const RETAINED_PORTFOLIO_FLOOR = 1 - MAX_PORTFOLIO_DRAWDOWN

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}
export interface SurvivalBudget {
  allowed: boolean
  floor: number
  remainingLossBudget: number
}

/**
 * Uses retained cash as a conservative lower bound for a verified long-only portfolio.
 * Values are kept at full precision; callers format only at the presentation boundary.
 */
export function survivalBudget(highWaterValue: number, retainedCash: number, proposedMaxLoss = 0): SurvivalBudget {
  if (!finitePositive(highWaterValue) || !Number.isFinite(retainedCash) || !Number.isFinite(proposedMaxLoss) || proposedMaxLoss < 0) {
    return { allowed: false, floor: 0, remainingLossBudget: 0 }
  }
  const floor = highWaterValue * RETAINED_PORTFOLIO_FLOOR
  const remainingLossBudget = Math.max(0, retainedCash - floor)
  return {
    allowed: proposedMaxLoss <= remainingLossBudget + Number.EPSILON,
    floor,
    remainingLossBudget,
  }
}
