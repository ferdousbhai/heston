const MAX_PORTFOLIO_DRAWDOWN = 0.40
const RETAINED_PORTFOLIO_FLOOR = 1 - MAX_PORTFOLIO_DRAWDOWN
const DEFAULT_KELLY_MULTIPLIER = 0.25

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0
}
/** Full Kelly for a bounded binary wager. Unknown or non-positive edge means no bet. */
export function kellyFraction(winProbability: number | undefined, netWinLossRatio: number | undefined): number {
  if (winProbability === undefined || netWinLossRatio === undefined) return 0
  if (!Number.isFinite(winProbability) || winProbability <= 0 || winProbability >= 1) return 0
  if (!finitePositive(netWinLossRatio)) return 0
  return Math.max(0, Math.min(1, winProbability - ((1 - winProbability) / netWinLossRatio)))
}

export function fractionalKelly(
  winProbability: number | undefined,
  netWinLossRatio: number | undefined,
  multiplier = DEFAULT_KELLY_MULTIPLIER,
): number {
  if (!Number.isFinite(multiplier) || multiplier <= 0 || multiplier > 1) return 0
  return kellyFraction(winProbability, netWinLossRatio) * multiplier
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
