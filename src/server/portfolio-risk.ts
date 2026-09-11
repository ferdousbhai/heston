import { survivalBudget } from '../domain/portfolio-risk'
import { type FreshOrderPlacement } from './agent-contracts'
import { type AppEnv } from './env'
import { OwnerVisibleError } from './owner-visible-error'
import { resolveEquityOptionContract, type EquityOptionContract } from './option-contract'
import { type BrokerAccountRef, type BrokerAccountSnapshot } from '../domain/broker'
import { brokerAdapterFor, BrokerSnapshotError } from './brokers'
import { BrokerCredentialMissingError, type BrokerCredential } from './broker-credential'

interface RiskPosition {
  direction: 'Long' | 'Short'
  instrumentType: string
  quantity: number
  symbol: string
}

interface RiskAccount {
  cash: number
  liveOrderCount: number
  netLiquidatingValue: number
  positions: RiskPosition[]
}

export interface PortfolioActionAssessment {
  allowed: boolean
  floor: number
  maxLoss: number
  reason?: string
  remainingLossBudget: number
}

export class PortfolioRiskError extends OwnerVisibleError {
  constructor(message: string) {
    super('portfolio-risk', message)
    this.name = 'PortfolioRiskError'
  }
}

/**
 * The drawdown guard's own wording for a snapshot it refuses to believe. The adapter reports
 * which of the four account reads failed and whether the page or a record inside it was
 * unreadable, so each of these stays as specific as it was when the guard did its own
 * parsing — these messages reach a member's agent and are how an incomplete account read is
 * told apart from a rejected trade.
 */
function riskError(error: BrokerSnapshotError): PortfolioRiskError {
  if (error.part === 'positions') {
    return new PortfolioRiskError(error.stage === 'record'
      ? 'The portfolio guard found an unsupported position record.'
      : `The portfolio guard could not verify every open position: ${error.message}.`)
  }
  if (error.part === 'balances') {
    return new PortfolioRiskError(`The portfolio guard could not verify balances: ${error.message}.`)
  }
  const label = error.part === 'orders' ? 'every ordinary live order' : 'every complex live order'
  return new PortfolioRiskError(`The portfolio guard could not verify ${label}: ${error.message}.`)
}

async function loadRiskAccount(
  env: AppEnv,
  ref: BrokerAccountRef,
  ignoredOrderId: string | undefined,
  credential: BrokerCredential | undefined,
): Promise<RiskAccount> {
  let snapshot: BrokerAccountSnapshot
  try {
    snapshot = await brokerAdapterFor(credential).loadAccountSnapshot(env, ref, credential)
  } catch (error) {
    if (error instanceof BrokerCredentialMissingError) throw error
    // A BrokerSnapshotError means the broker answered something the adapter refuses to
    // believe; anything else means it would not answer at all.
    if (error instanceof BrokerSnapshotError) throw riskError(error)
    throw new PortfolioRiskError('The portfolio guard could not refresh the complete brokerage account.')
  }
  const { netLiquidatingValue, cashBalance, cashAvailableToWithdraw } = snapshot.balances
  if (netLiquidatingValue <= 0) {
    throw new PortfolioRiskError('The portfolio guard could not verify net liquidation value and unencumbered cash.')
  }
  const cash = Math.min(cashBalance, cashAvailableToWithdraw)
  if (cash < 0) throw new PortfolioRiskError('The portfolio guard found a negative cash reserve.')
  return {
    netLiquidatingValue,
    cash,
    positions: snapshot.positions,
    // Counted from the rows the broker listed, not the expanded working orders: a complex
    // order whose children have all gone terminal still occupies the account, and expansion
    // would drop it. Only the ordinary row being replaced is excluded, so a replacement is
    // never blocked by the order it replaces.
    liveOrderCount: snapshot.liveOrders
      .filter((row) => row.source !== 'ordinary' || row.id !== ignoredOrderId).length,
  }
}

/** Account state is keyed here, but the request credential is deliberately never persisted with it. */
async function recordPortfolioHighWater(
  env: AppEnv,
  accountNumber: string,
  netLiquidatingValue: number,
  credential: BrokerCredential | undefined,
): Promise<number> {
  if (!credential) throw new BrokerCredentialMissingError()
  if (!env.DB || !accountNumber || !Number.isFinite(netLiquidatingValue) || netLiquidatingValue <= 0) {
    throw new PortfolioRiskError('The high-water portfolio guard is unavailable.')
  }
  const now = new Date().toISOString()
  // Keyed by broker as well as account: two brokers can issue the same account number, and
  // sharing a high-water mark between them would silently resize someone's loss budget.
  await env.DB.prepare(
    `INSERT INTO portfolio_risk_state (broker_id, account_number, high_water_nlv, activated_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(broker_id, account_number) DO UPDATE SET
       high_water_nlv = MAX(portfolio_risk_state.high_water_nlv, excluded.high_water_nlv),
       updated_at = excluded.updated_at`,
  ).bind(credential.broker, accountNumber, netLiquidatingValue, now, now).run()
  const row = await env.DB.prepare(
    'SELECT high_water_nlv FROM portfolio_risk_state WHERE broker_id = ? AND account_number = ?',
  ).bind(credential.broker, accountNumber).first<{ high_water_nlv: number }>()
  if (!row || !Number.isFinite(row.high_water_nlv) || row.high_water_nlv <= 0) {
    throw new PortfolioRiskError('The high-water portfolio guard is unavailable.')
  }
  return row.high_water_nlv
}

function unsupportedOpeningPosition(position: RiskPosition): boolean {
  return position.direction !== 'Long'
    || (position.instrumentType !== 'Equity' && position.instrumentType !== 'Equity Option')
}

function closingPosition(
  action: FreshOrderPlacement,
  account: RiskAccount,
  optionContract?: EquityOptionContract,
): RiskPosition | undefined {
  if (action.kind === 'place_vertical_spread_order') return undefined
  const symbol = action.kind === 'place_option_order' ? optionContract?.symbol : action.symbol
  const instrumentType = action.kind === 'place_option_order' ? 'Equity Option' : 'Equity'
  const direction = action.action === 'Sell to Close' ? 'Long' : 'Short'
  return account.positions.find((position) => position.symbol === symbol
    && position.instrumentType === instrumentType
    && position.direction === direction
    && position.quantity >= action.quantity)
}

export function assessPortfolioAction(
  action: FreshOrderPlacement,
  account: RiskAccount,
  highWaterValue: number,
  optionContracts: readonly EquityOptionContract[] = [],
): PortfolioActionAssessment {
  const budget = survivalBudget(highWaterValue, account.cash)
  if (account.liveOrderCount > 0) {
    return { ...budget, maxLoss: 0, allowed: false, reason: 'Cancel or wait for every live order before placing another trade.' }
  }
  const isClose = action.kind !== 'place_vertical_spread_order'
    && (action.action === 'Sell to Close' || action.action === 'Buy to Close')
  if (isClose) {
    if (!closingPosition(action, account, optionContracts[0])) {
      return { ...budget, maxLoss: 0, allowed: false, reason: 'The requested close is larger than the verified matching position.' }
    }
    if (action.action === 'Sell to Close' && account.positions.some(unsupportedOpeningPosition)) {
      return { ...budget, maxLoss: 0, allowed: false, reason: 'This account will not remove long collateral or protection while unsupported short exposure remains.' }
    }
    return { ...budget, maxLoss: 0, allowed: true }
  }
  if (action.kind !== 'place_vertical_spread_order'
    && (action.action !== 'Buy to Open' || action.priceEffect !== 'Debit')) {
    return { ...budget, maxLoss: Number.POSITIVE_INFINITY, allowed: false, reason: 'This account will not open a naked or unbounded short position.' }
  }
  if (account.positions.some(unsupportedOpeningPosition)) {
    return { ...budget, maxLoss: Number.POSITIVE_INFINITY, allowed: false, reason: 'Existing short, futures, or unsupported exposure prevents a contractually bounded portfolio floor.' }
  }
  const multiplier = action.kind === 'place_equity_order' ? 1 : optionContracts[0]?.sharesPerContract
  if (multiplier === undefined || !Number.isFinite(multiplier) || multiplier <= 0) {
    return { ...budget, maxLoss: Number.POSITIVE_INFINITY, allowed: false, reason: 'The option contract multiplier could not be verified.' }
  }
  const maxLoss = action.quantity * action.limitPrice * multiplier
  const proposedBudget = survivalBudget(highWaterValue, account.cash, maxLoss)
  return proposedBudget.allowed
    ? { ...proposedBudget, maxLoss }
    : {
        ...proposedBudget,
        maxLoss,
        reason: `Maximum order loss ${money(maxLoss)} exceeds the remaining ${money(proposedBudget.remainingLossBudget)} portfolio-loss budget.`,
      }
}

function money(value: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value)
}

export async function assertPortfolioActionAllowed(
  env: AppEnv,
  action: FreshOrderPlacement,
  credential: BrokerCredential | undefined,
  resolved: { accountNumber?: string; ignoredOrderId?: string; optionContracts?: readonly EquityOptionContract[] } = {},
): Promise<PortfolioActionAssessment> {
  const adapter = brokerAdapterFor(credential)
  const ref = resolved.accountNumber
    ? { accountNumber: resolved.accountNumber, broker: adapter.id }
    : await adapter.resolveAccountRef(env, credential)
  const account = await loadRiskAccount(env, ref, resolved.ignoredOrderId, credential)
  let optionContracts = resolved.optionContracts ?? []
  if (action.kind === 'place_option_order' && !optionContracts.length) {
    optionContracts = [await resolveEquityOptionContract(env, action)]
  }
  if (action.kind === 'place_vertical_spread_order' && optionContracts.length !== 2) {
    throw new PortfolioRiskError('The guard could not verify both spread contracts.')
  }
  const highWaterValue = await recordPortfolioHighWater(env, ref.accountNumber, account.netLiquidatingValue, credential)
  const assessment = assessPortfolioAction(action, account, highWaterValue, optionContracts)
  if (!assessment.allowed) throw new PortfolioRiskError(assessment.reason ?? 'This trade was rejected at the portfolio boundary.')
  return assessment
}
