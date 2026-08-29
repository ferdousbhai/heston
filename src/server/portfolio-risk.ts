import { PORTFOLIO_POLICY, survivalBudget } from '../domain/portfolio-risk'
import { type FreshOrderPlacement } from './agent-contracts'
import { type BrokerageContext } from './brokerage-context'
import { type AppEnv } from './env'
import { resolveEquityOptionContract, type EquityOptionContract } from './option-contract'
import {
  JsonArraySchema,
  jsonNumber,
  JsonObjectArraySchema,
  jsonObjectOrEmpty,
  jsonTextOrEmpty,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { brokerApi } from './tastytrade'
import { accountBalanceRecord, isWorkingOrderRecord } from './tastytrade-payload'

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

export interface PortfolioPolicyContext {
  availableNewRisk?: number
  cash?: number
  cashPercent?: number
  modeledFloor?: number
  highWaterValue?: number
  maxDrawdownPercent: typeof PORTFOLIO_POLICY.maxDrawdownPercent
  status: 'approximate-new-risk-budget' | 'risk-increasing-actions-blocked' | 'unavailable'
}

export class PortfolioRiskError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortfolioRiskError'
  }
}

function strictItems(value: JsonValue, label: string): JsonObject[] {
  const body = jsonObjectOrEmpty(value)
  const data = jsonObjectOrEmpty(body.data)
  const candidate = JsonArraySchema.safeParse(value).data
    ?? JsonArraySchema.safeParse(data.items ?? body.items).data
  const rows = candidate && JsonObjectArraySchema.safeParse(candidate).data
  if (!rows) throw new PortfolioRiskError(`Dan's portfolio guard could not verify ${label}.`)
  return rows
}

function paginationTotal(value: JsonValue): number | undefined {
  const body = jsonObjectOrEmpty(value)
  const data = jsonObjectOrEmpty(body.data)
  const pagination = jsonObjectOrEmpty(body.pagination ?? data.pagination)
  const total = jsonNumber(pagination['total-items'])
  return total !== undefined && Number.isSafeInteger(total) && total >= 0 ? total : undefined
}

function completeOrderRows(value: JsonValue, label: string, pageLimit: number): JsonObject[] {
  const rows = strictItems(value, label)
  const total = paginationTotal(value)
  if ((total !== undefined && total > rows.length) || (total === undefined && rows.length >= pageLimit)) {
    throw new PortfolioRiskError(`Dan's portfolio guard could not verify ${label}.`)
  }
  return rows
}

function balanceValue(balances: JsonObject, names: string[]): number | undefined {
  return names.map((name) => jsonNumber(balances[name])).find((value) => value !== undefined)
}

function positionRows(payload: JsonValue): RiskPosition[] {
  return completeOrderRows(payload, 'every open position', 200).flatMap((row) => {
    const symbol = jsonTextOrEmpty(row.symbol)
    const instrumentType = jsonTextOrEmpty(row['instrument-type'])
    const direction = row['quantity-direction']
    const quantity = jsonNumber(row.quantity)
    if (!symbol || !instrumentType || (direction !== 'Long' && direction !== 'Short') || quantity === undefined || quantity < 0) {
      throw new PortfolioRiskError("Dan's portfolio guard found an unsupported position record.")
    }
    return quantity === 0 ? [] : [{ symbol, instrumentType, direction, quantity }]
  })
}

async function loadRiskAccount(env: AppEnv, accountNumber: string, ignoredOrderId?: string): Promise<RiskAccount> {
  let positionPayload: JsonValue
  let balancePayload: JsonValue
  let orderPayload: JsonValue
  let complexOrderPayload: JsonValue
  try {
    [positionPayload, balancePayload, orderPayload, complexOrderPayload] = await Promise.all([
      brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/positions?per-page=200`),
      brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/balances`),
      brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/orders/live?per-page=200`),
      brokerApi().tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/complex-orders/live?per-page=200`),
    ])
  } catch {
    throw new PortfolioRiskError("Dan's portfolio guard could not refresh the complete tastytrade account.")
  }
  const balances = accountBalanceRecord(balancePayload, accountNumber)
  if (!balances) throw new PortfolioRiskError("Dan's portfolio guard could not verify one account balance record.")
  const netLiquidatingValue = balanceValue(balances, ['net-liquidating-value', 'net-liquidating-value-snapshot'])
  const cashBalance = balanceValue(balances, ['cash-balance'])
  const withdrawableCash = balanceValue(balances, ['cash-available-to-withdraw'])
  if (netLiquidatingValue === undefined || netLiquidatingValue <= 0
    || cashBalance === undefined || withdrawableCash === undefined) {
    throw new PortfolioRiskError("Dan's portfolio guard could not verify net liquidation value and unencumbered cash.")
  }
  const cash = Math.min(cashBalance, withdrawableCash)
  if (cash < 0) throw new PortfolioRiskError("Dan's portfolio guard found a negative cash reserve.")
  return {
    netLiquidatingValue,
    cash,
    positions: positionRows(positionPayload),
    liveOrderCount: completeOrderRows(orderPayload, 'every ordinary live order', 200)
      .filter((row) => String(row.id ?? '') !== ignoredOrderId)
      .filter(isWorkingOrderRecord).length
      + completeOrderRows(complexOrderPayload, 'every complex live order', 200).filter(isWorkingOrderRecord).length,
  }
}

async function recordPortfolioHighWater(env: AppEnv, accountNumber: string, netLiquidatingValue: number): Promise<number> {
  if (!env.DB || !accountNumber || !Number.isFinite(netLiquidatingValue) || netLiquidatingValue <= 0) {
    throw new PortfolioRiskError("Dan's high-water portfolio guard is unavailable.")
  }
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO portfolio_risk_state (account_number, high_water_nlv, activated_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_number) DO UPDATE SET
       high_water_nlv = MAX(portfolio_risk_state.high_water_nlv, excluded.high_water_nlv),
       updated_at = excluded.updated_at`,
  ).bind(accountNumber, netLiquidatingValue, now, now).run()
  const row = await env.DB.prepare(
    'SELECT high_water_nlv FROM portfolio_risk_state WHERE account_number = ?',
  ).bind(accountNumber).first<{ high_water_nlv: number }>()
  if (!row || !Number.isFinite(row.high_water_nlv) || row.high_water_nlv <= 0) {
    throw new PortfolioRiskError("Dan's high-water portfolio guard is unavailable.")
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
    return { ...budget, maxLoss: 0, allowed: false, reason: 'Cancel or wait for every live order before Dan drafts another trade.' }
  }
  const isClose = action.kind !== 'place_vertical_spread_order'
    && (action.action === 'Sell to Close' || action.action === 'Buy to Close')
  if (isClose) {
    if (!closingPosition(action, account, optionContracts[0])) {
      return { ...budget, maxLoss: 0, allowed: false, reason: 'The requested close is larger than the verified matching position.' }
    }
    if (action.action === 'Sell to Close' && account.positions.some(unsupportedOpeningPosition)) {
      return { ...budget, maxLoss: 0, allowed: false, reason: 'Dan will not remove long collateral or protection while unsupported short exposure remains.' }
    }
    return { ...budget, maxLoss: 0, allowed: true }
  }
  if (action.kind !== 'place_vertical_spread_order'
    && (action.action !== 'Buy to Open' || action.priceEffect !== 'Debit')) {
    return { ...budget, maxLoss: Number.POSITIVE_INFINITY, allowed: false, reason: 'Dan will not open a naked or unbounded short position.' }
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
  resolved: { accountNumber?: string; ignoredOrderId?: string; optionContracts?: readonly EquityOptionContract[] } = {},
): Promise<PortfolioActionAssessment> {
  const accountNumber = resolved.accountNumber ?? await brokerApi().resolveAccountNumber(env)
  const account = await loadRiskAccount(env, accountNumber, resolved.ignoredOrderId)
  let optionContracts = resolved.optionContracts ?? []
  if (action.kind === 'place_option_order' && !optionContracts.length) {
    optionContracts = [await resolveEquityOptionContract(env, action)]
  }
  if (action.kind === 'place_vertical_spread_order' && optionContracts.length !== 2) {
    throw new PortfolioRiskError('Dan could not verify both spread contracts.')
  }
  const highWaterValue = await recordPortfolioHighWater(env, accountNumber, account.netLiquidatingValue)
  const assessment = assessPortfolioAction(action, account, highWaterValue, optionContracts)
  if (!assessment.allowed) throw new PortfolioRiskError(assessment.reason ?? 'Dan rejected this trade at the portfolio boundary.')
  return assessment
}

export async function buildPortfolioPolicyContext(env: AppEnv, account: BrokerageContext): Promise<PortfolioPolicyContext> {
  const netLiquidatingValue = account.balances.netLiquidatingValue
  const cashBalance = account.balances.cashBalance
  const withdrawableCash = account.balances.cashAvailableToWithdraw
  if (!account.availability.balances || netLiquidatingValue === undefined
    || cashBalance === undefined || withdrawableCash === undefined || netLiquidatingValue <= 0) {
    return { maxDrawdownPercent: PORTFOLIO_POLICY.maxDrawdownPercent, status: 'unavailable' }
  }
  const cash = Math.min(cashBalance, withdrawableCash)
  try {
    const highWaterValue = await recordPortfolioHighWater(env, account.accountNumber, netLiquidatingValue)
    const budget = survivalBudget(highWaterValue, cash)
    const supported = budget.allowed
      && account.availability.positions
      && account.availability.orders
      && account.orders.length === 0
      && account.positions.every((position) => position.direction === 'Long'
        && (position.instrumentType === 'Equity' || position.instrumentType === 'Equity Option'))
    return {
      maxDrawdownPercent: PORTFOLIO_POLICY.maxDrawdownPercent,
      status: supported ? 'approximate-new-risk-budget' : 'risk-increasing-actions-blocked',
      highWaterValue,
      modeledFloor: budget.floor,
      cash,
      cashPercent: (cash / netLiquidatingValue) * 100,
      availableNewRisk: supported ? budget.remainingLossBudget : 0,
    }
  } catch {
    return { maxDrawdownPercent: PORTFOLIO_POLICY.maxDrawdownPercent, status: 'unavailable' }
  }
}
