import { survivalBudget } from '../domain/portfolio-risk'
import { type BrokerageAction } from './agent-contracts'
import { type BrokerageContext } from './brokerage-context'
import { type AppEnv } from './env'
import { resolveEquityOptionContract, type EquityOptionContract } from './option-contract'
import { resolveAccountNumber, tastyRequest } from './tastytrade'

type JsonRecord = Record<string, unknown>

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
  maxDrawdownPercent: 40
  status: 'approximate-new-risk-budget' | 'risk-increasing-actions-blocked' | 'unavailable'
}

export class PortfolioRiskError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortfolioRiskError'
  }
}

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? value as JsonRecord : {}
}

function strictItems(value: unknown, label: string): JsonRecord[] {
  if (Array.isArray(value)) return value.map(record)
  const body = record(value)
  const data = record(body.data)
  const candidate = data.items ?? body.items
  if (!Array.isArray(candidate)) throw new PortfolioRiskError(`Dan's portfolio guard could not verify ${label}.`)
  return candidate.map(record)
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function balanceValue(balances: JsonRecord, names: string[]): number | undefined {
  return names.map((name) => finiteNumber(balances[name])).find((value) => value !== undefined)
}

function positionRows(payload: unknown): RiskPosition[] {
  return strictItems(payload, 'every open position').flatMap((row) => {
    const symbol = typeof row.symbol === 'string' ? row.symbol.trim() : ''
    const instrumentType = typeof row['instrument-type'] === 'string' ? row['instrument-type'].trim() : ''
    const direction = row['quantity-direction']
    const quantity = finiteNumber(row.quantity)
    if (!symbol || !instrumentType || (direction !== 'Long' && direction !== 'Short') || quantity === undefined || quantity < 0) {
      throw new PortfolioRiskError("Dan's portfolio guard found an unsupported position record.")
    }
    return quantity === 0 ? [] : [{ symbol, instrumentType, direction, quantity }]
  })
}

async function loadRiskAccount(env: AppEnv, accountNumber: string): Promise<RiskAccount> {
  let positionPayload: unknown
  let balancePayload: unknown
  let orderPayload: unknown
  let complexOrderPayload: unknown
  try {
    [positionPayload, balancePayload, orderPayload, complexOrderPayload] = await Promise.all([
      tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/positions`),
      tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/balances`),
      tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/orders/live?per-page=200`),
      tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/complex-orders/live`),
    ])
  } catch {
    throw new PortfolioRiskError("Dan's portfolio guard could not refresh the complete tastytrade account.")
  }
  const body = record(balancePayload)
  const balances = record(body.data ?? body)
  const netLiquidatingValue = balanceValue(balances, ['net-liquidating-value', 'net-liquidating-value-snapshot'])
  const cashBalance = balanceValue(balances, ['cash-balance'])
  const withdrawableCash = balanceValue(balances, ['cash-available-to-withdraw'])
  if (netLiquidatingValue === undefined || netLiquidatingValue <= 0
    || cashBalance === undefined || withdrawableCash === undefined) {
    const rawData = body.data
    const dataRecord = record(rawData)
    console.warn('PortfolioBalanceFieldsUnavailable', JSON.stringify({
      topLevelKeys: Object.keys(body).sort(),
      dataKind: Array.isArray(rawData) ? 'array' : rawData === null ? 'null' : typeof rawData,
      dataKeys: Object.keys(dataRecord).sort(),
      dataItemCount: Array.isArray(dataRecord.items) ? dataRecord.items.length : undefined,
      keys: Object.keys(balances).filter((key) => /cash|liquid|withdraw/i.test(key)).sort(),
      hasNetLiquidatingValue: netLiquidatingValue !== undefined,
      hasCashBalance: cashBalance !== undefined,
      hasWithdrawableCash: withdrawableCash !== undefined,
    }))
    throw new PortfolioRiskError("Dan's portfolio guard could not verify net liquidation value and unencumbered cash.")
  }
  const cash = Math.min(cashBalance, withdrawableCash)
  if (cash < 0) throw new PortfolioRiskError("Dan's portfolio guard found a negative cash reserve.")
  return {
    netLiquidatingValue,
    cash,
    positions: positionRows(positionPayload),
    liveOrderCount: strictItems(orderPayload, 'every ordinary live order').length
      + strictItems(complexOrderPayload, 'every complex live order').length,
  }
}

export async function recordPortfolioHighWater(env: AppEnv, accountNumber: string, netLiquidatingValue: number): Promise<number> {
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
  action: Extract<BrokerageAction, { kind: 'place_option_order' | 'place_equity_order' }>,
  account: RiskAccount,
  optionContract?: EquityOptionContract,
): RiskPosition | undefined {
  const symbol = action.kind === 'place_option_order' ? optionContract?.symbol : action.symbol
  const instrumentType = action.kind === 'place_option_order' ? 'Equity Option' : 'Equity'
  const direction = action.action === 'Sell to Close' ? 'Long' : 'Short'
  return account.positions.find((position) => position.symbol === symbol
    && position.instrumentType === instrumentType
    && position.direction === direction
    && position.quantity >= action.quantity)
}

export function assessPortfolioAction(
  action: Extract<BrokerageAction, { kind: 'place_option_order' | 'place_equity_order' }>,
  account: RiskAccount,
  highWaterValue: number,
  optionContract?: EquityOptionContract,
): PortfolioActionAssessment {
  const budget = survivalBudget(highWaterValue, account.cash)
  if (account.liveOrderCount > 0) {
    return { ...budget, maxLoss: 0, allowed: false, reason: 'Cancel or wait for every live order before Dan drafts another trade.' }
  }
  const isClose = action.action === 'Sell to Close' || action.action === 'Buy to Close'
  if (isClose) {
    if (!closingPosition(action, account, optionContract)) {
      return { ...budget, maxLoss: 0, allowed: false, reason: 'The requested close is larger than the verified matching position.' }
    }
    return { ...budget, maxLoss: 0, allowed: true }
  }
  if (action.action !== 'Buy to Open' || action.priceEffect !== 'Debit') {
    return { ...budget, maxLoss: Number.POSITIVE_INFINITY, allowed: false, reason: 'Dan will not open a naked or unbounded short position.' }
  }
  if (account.positions.some(unsupportedOpeningPosition)) {
    return { ...budget, maxLoss: Number.POSITIVE_INFINITY, allowed: false, reason: 'Existing short, futures, or unsupported exposure prevents a contractually bounded portfolio floor.' }
  }
  const multiplier = action.kind === 'place_option_order' ? optionContract?.sharesPerContract : 1
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
  action: BrokerageAction,
  resolved: { accountNumber?: string; optionContract?: EquityOptionContract } = {},
): Promise<PortfolioActionAssessment> {
  if (action.kind === 'cancel_order' || action.kind === 'add_watchlist_symbol' || action.kind === 'remove_watchlist_symbol') {
    return { allowed: true, floor: 0, maxLoss: 0, remainingLossBudget: 0 }
  }
  const accountNumber = resolved.accountNumber ?? await resolveAccountNumber(env)
  const [account, optionContract] = await Promise.all([
    loadRiskAccount(env, accountNumber),
    action.kind === 'place_option_order'
      ? resolved.optionContract ?? resolveEquityOptionContract(env, action)
      : undefined,
  ])
  const highWaterValue = await recordPortfolioHighWater(env, accountNumber, account.netLiquidatingValue)
  const assessment = assessPortfolioAction(action, account, highWaterValue, optionContract)
  if (!assessment.allowed) throw new PortfolioRiskError(assessment.reason ?? 'Dan rejected this trade at the portfolio boundary.')
  return assessment
}

export async function buildPortfolioPolicyContext(env: AppEnv, account: BrokerageContext): Promise<PortfolioPolicyContext> {
  const netLiquidatingValue = account.balances.netLiquidatingValue
  const cash = account.balances.cash
  if (!account.availability.balances || netLiquidatingValue === undefined || cash === undefined || netLiquidatingValue <= 0) {
    return { maxDrawdownPercent: 40, status: 'unavailable' }
  }
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
      maxDrawdownPercent: 40,
      status: supported ? 'approximate-new-risk-budget' : 'risk-increasing-actions-blocked',
      highWaterValue,
      modeledFloor: budget.floor,
      cash,
      cashPercent: (cash / netLiquidatingValue) * 100,
      availableNewRisk: supported ? budget.remainingLossBudget : 0,
    }
  } catch {
    return { maxDrawdownPercent: 40, status: 'unavailable' }
  }
}
