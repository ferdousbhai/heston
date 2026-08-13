import { formatMarketMetric, type Ticker } from '../domain/market'
import { AgentPlanSchema } from './agent-contracts'

export function demoPlan(message: string, ticker: Ticker | undefined) {
  const optionMatch = message.match(/\b(buy|sell)\s+(\d+)\s+([A-Za-z.]{1,8})\s+(\d+(?:\.\d+)?)\s*(call|put).*?(\d{4}-\d{2}-\d{2}).*?(?:\$|at\s+)(\d+(?:\.\d+)?)/i)
  if (optionMatch) {
    const verb = optionMatch[1]?.toLowerCase()
    if (verb === 'sell') {
      return AgentPlanSchema.parse({
        message: 'I will not draft a naked short option. Give me a bounded debit structure or use a defined-risk multi-leg order in tastytrade.',
        action: null,
      })
    }
    return AgentPlanSchema.parse({
      message: 'I drafted the defined order below. Review every field—especially expiration, strike, and debit—before confirming.',
      action: {
        kind: 'place_option_order', action: verb === 'buy' ? 'Buy to Open' : 'Sell to Open',
        quantity: Number(optionMatch[2]), underlying: optionMatch[3]!.toUpperCase(), strike: Number(optionMatch[4]),
        optionType: optionMatch[5]?.toLowerCase() === 'call' ? 'C' : 'P', expiry: optionMatch[6]!,
        limitPrice: Number(optionMatch[7]), priceEffect: verb === 'buy' ? 'Debit' : 'Credit',
      },
    })
  }
  if (ticker) {
    const premium = ticker.ivRank >= 70 ? 'rich' : ticker.ivRank <= 30 ? 'cheap' : 'mid-range'
    return AgentPlanSchema.parse({
      message: `${ticker.symbol} options look ${premium}: IV rank is ${formatMarketMetric(ticker.ivRank)}, IV percentile is ${formatMarketMetric(ticker.ivPercentile)}, implied volatility is ${formatMarketMetric(ticker.ivIndex)}%, and liquidity is ${formatMarketMetric(ticker.liquidity)}/5. ${ticker.ivRank >= 70 ? 'I would avoid an unhedged long-premium entry unless the catalyst can clear the implied move.' : 'A defined-risk structure is worth comparing across expirations.'}`,
      action: null,
    })
  }
  return AgentPlanSchema.parse({ message: 'I can compare option premium, inspect your positions, or draft a defined-risk order. Order placement always pauses for your confirmation.', action: null })
}
