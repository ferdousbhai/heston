// Owner-approved survival policy: enforcement and Dan's context must read this
// same value so advice cannot drift from the server-side execution boundary.
export const PORTFOLIO_POLICY = {
  maxDrawdownPercent: 40,
} as const

const RETAINED_PORTFOLIO_FLOOR = 1 - PORTFOLIO_POLICY.maxDrawdownPercent / 100

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
