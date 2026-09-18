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
  positions: RiskPosition[]
}

export interface PortfolioActionAssessment {
  allowed: boolean
  maxLoss: number
  reason?: string
}

export class PortfolioRiskError extends OwnerVisibleError {
  constructor(message: string) {
    super('portfolio-risk', message)
    this.name = 'PortfolioRiskError'
  }
}

/**
 * The portfolio guard's own wording for a snapshot it refuses to believe. The adapter reports
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
  const { netLiquidatingValue, cashBalance } = snapshot.balances
  if (netLiquidatingValue <= 0) {
    throw new PortfolioRiskError('The portfolio guard could not verify net liquidation value.')
  }
  if (cashBalance < 0) throw new PortfolioRiskError('The portfolio guard found a negative cash reserve.')
  return { positions: snapshot.positions }
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
  optionContracts: readonly EquityOptionContract[] = [],
): PortfolioActionAssessment {
  const isClose = action.kind !== 'place_vertical_spread_order'
    && (action.action === 'Sell to Close' || action.action === 'Buy to Close')
  if (isClose) {
    if (!closingPosition(action, account, optionContracts[0])) {
      return { maxLoss: 0, allowed: false, reason: 'The requested close is larger than the verified matching position.' }
    }
    if (action.action === 'Sell to Close' && account.positions.some(unsupportedOpeningPosition)) {
      return { maxLoss: 0, allowed: false, reason: 'This account will not remove long collateral or protection while unsupported short exposure remains.' }
    }
    return { maxLoss: 0, allowed: true }
  }
  if (action.kind !== 'place_vertical_spread_order'
    && (action.action !== 'Buy to Open' || action.priceEffect !== 'Debit')) {
    return { maxLoss: Number.POSITIVE_INFINITY, allowed: false, reason: 'This account will not open a naked or unbounded short position.' }
  }
  if (account.positions.some(unsupportedOpeningPosition)) {
    return { maxLoss: Number.POSITIVE_INFINITY, allowed: false, reason: 'Existing short, futures, or unsupported exposure prevents a contractually bounded portfolio floor.' }
  }
  const multiplier = action.kind === 'place_equity_order' ? 1 : optionContracts[0]?.sharesPerContract
  if (multiplier === undefined || !Number.isFinite(multiplier) || multiplier <= 0) {
    return { maxLoss: Number.POSITIVE_INFINITY, allowed: false, reason: 'The option contract multiplier could not be verified.' }
  }
  // The limit is the debit. Buying power is the broker dry-run, not a second cash floor.
  return { allowed: true, maxLoss: action.quantity * action.limitPrice * multiplier }
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
  const account = await loadRiskAccount(env, ref, credential)
  let optionContracts = resolved.optionContracts ?? []
  if (action.kind === 'place_option_order' && !optionContracts.length) {
    optionContracts = [await resolveEquityOptionContract(env, action)]
  }
  if (action.kind === 'place_vertical_spread_order' && optionContracts.length !== 2) {
    throw new PortfolioRiskError('The guard could not verify both spread contracts.')
  }
  const assessment = assessPortfolioAction(action, account, optionContracts)
  if (!assessment.allowed) throw new PortfolioRiskError(assessment.reason ?? 'This trade was rejected at the portfolio boundary.')
  return assessment
}
