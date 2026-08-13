import { type Ticker } from '../domain/market'
import { AgentPlanSchema, type ChatRequest } from './agent-contracts'
import { type AppEnv, isLiveTastytrade } from './env'
import { type BrokerageContext } from './brokerage-context'

type AiTextResult = { response?: string }

function tickerContext(ticker: Ticker | undefined) {
  if (!ticker) return undefined
  return {
    symbol: ticker.symbol, price: ticker.price, changePercent: ticker.changePercent,
    ivRank: ticker.ivRank, ivPercentile: ticker.ivPercentile, ivIndex: ticker.ivIndex,
    liquidity: ticker.liquidity, earningsDate: ticker.earningsDate, position: ticker.position,
  }
}

function demoPlan(message: string, ticker: Ticker | undefined) {
  const optionMatch = message.match(/\b(buy|sell)\s+(\d+)\s+([A-Za-z.]{1,8})\s+(\d+(?:\.\d+)?)\s*(call|put).*?(\d{4}-\d{2}-\d{2}).*?(?:\$|at\s+)(\d+(?:\.\d+)?)/i)
  if (optionMatch) {
    const verb = optionMatch[1]?.toLowerCase()
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
  if (/\bcancel\b/i.test(message)) {
    const orderId = message.match(/\b\d{3,40}\b/)?.[0]
    if (orderId) return AgentPlanSchema.parse({ message: 'I found the working order. Confirm below if you want it cancelled.', action: { kind: 'cancel_order', orderId } })
  }
  if (ticker) {
    const premium = ticker.ivRank >= 70 ? 'rich' : ticker.ivRank <= 30 ? 'cheap' : 'mid-range'
    return AgentPlanSchema.parse({
      message: `${ticker.symbol} options look ${premium}: IV rank is ${ticker.ivRank}, IV percentile is ${ticker.ivPercentile}, implied volatility is ${ticker.ivIndex.toFixed(1)}%, and liquidity is ${ticker.liquidity}/5. ${ticker.ivRank >= 70 ? 'I would avoid an unhedged long-premium entry unless the catalyst can clear the implied move.' : 'A defined-risk structure is worth comparing across expirations.'}`,
      action: null,
    })
  }
  return AgentPlanSchema.parse({ message: 'I can compare option premium, inspect your positions, draft a defined-risk order, or cancel a working order. Any brokerage write pauses for your confirmation.', action: null })
}

export async function planAgentReply(env: AppEnv, input: ChatRequest, ticker: Ticker | undefined, account?: BrokerageContext) {
  if (!env.AI || !isLiveTastytrade(env)) return demoPlan(input.message, ticker)
  const result = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
    messages: [
      { role: 'system', content: 'You are Dan, a terse and skeptical options trading assistant. Use only the supplied account and market context. Explain volatility with IV rank, IV percentile, IV index, liquidity, catalyst, and downside. Never invent an account fact. Only create an action when every required field is explicit in the user request. Never claim execution; every brokerage or watchlist write is a draft requiring confirmation. Return JSON only.' },
      { role: 'user', content: `Selected ticker context: ${JSON.stringify(tickerContext(ticker))}. Account context: ${JSON.stringify(account)}. User: ${input.message}. Return {message, action}. action is null or exactly one of place_option_order, place_equity_order, cancel_order, add_watchlist_symbol, remove_watchlist_symbol with all schema fields. Watchlist actions require watchlistName and symbol.` },
    ],
    response_format: { type: 'json_schema', json_schema: { type: 'object', properties: { message: { type: 'string' }, action: { type: ['object', 'null'] } }, required: ['message', 'action'] } },
    max_tokens: 900,
    temperature: 0.2,
  }) as AiTextResult
  return AgentPlanSchema.parse(JSON.parse(result.response ?? '{}'))
}
