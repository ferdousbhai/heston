import { z } from 'zod'

import { HttpsSourceUrlSchema } from './https-url'
import { EquitySymbolSchema } from './instrument'
import { IsoDateSchema } from './iso-date'

/*
 * The daily brief as the Long Vol channel published it: a trade line and a thesis per name, and
 * the morning's market-moving links. It is produced by exactly one writer, the private long-vol
 * Workflow, and delivered through `BriefPublisher`; this schema is the contract that boundary
 * holds the submission to, and the shape every reader of a stored brief gets back.
 *
 * Every bound below is a rendering envelope for untrusted model text, not a research limit.
 */

/** tastytrade's leg actions, as the channel always wrote them. */
export const BRIEF_TRADE_ACTIONS = ['BUY_TO_OPEN', 'SELL_TO_CLOSE', 'BUY_TO_CLOSE', 'SELL_TO_OPEN', 'BUY', 'SELL'] as const
export const BRIEF_DIRECTIONS = ['bullish', 'bearish', 'neutral'] as const
/** One Telegram message was the channel's envelope for a thesis; the site keeps that measure. */
export const MAX_THESIS_LENGTH = 4_096
/** A trade line is one short line: `NVDA 1/16/26: Buy 150c Sell 170c` is the long case. */
export const MAX_TRADE_LABEL_LENGTH = 80
/** A morning's hot page yields a few dozen links at most; more than this is a sweep, not a reading list. */
export const MAX_BRIEF_LINKS = 50
/** High conviction only: a brief that argues more names than this is a screener dump. */
export const MAX_BRIEF_RECOMMENDATIONS = 10
export const MAX_BRIEF_MODEL_LENGTH = 80

const OPTION_ACTIONS: ReadonlySet<string> = new Set(['BUY_TO_OPEN', 'SELL_TO_CLOSE', 'BUY_TO_CLOSE', 'SELL_TO_OPEN'])

export const TradeLegSchema = z.strictObject({
  action: z.enum(BRIEF_TRADE_ACTIONS),
  optionType: z.enum(['C', 'P']).optional(),
  strike: z.number().positive().optional(),
  expiry: IsoDateSchema.optional(),
}).superRefine((leg, context) => {
  // An option action needs its whole contract and a stock action carries none; a leg that is
  // neither is refused here rather than rendered as either.
  const option = OPTION_ACTIONS.has(leg.action)
  const contract = leg.optionType !== undefined && leg.strike !== undefined && leg.expiry !== undefined
  const bare = leg.optionType === undefined && leg.strike === undefined && leg.expiry === undefined
  if (option && !contract) context.addIssue({ code: 'custom', message: 'An option leg needs optionType, strike and expiry' })
  if (!option && !bare) context.addIssue({ code: 'custom', message: 'A stock leg carries no contract' })
})

export const BriefRecommendationSchema = z.strictObject({
  symbol: EquitySymbolSchema,
  direction: z.enum(BRIEF_DIRECTIONS),
  /** The channel's one-line trade, already formatted by the producer from `legs`. */
  trade: z.string().min(1).max(MAX_TRADE_LABEL_LENGTH),
  legs: z.array(TradeLegSchema).min(1),
  /** Markdown, rendered by the site's own subset renderer; never HTML. */
  thesis: z.string().min(1).max(MAX_THESIS_LENGTH),
})

export const BriefLinkSchema = z.strictObject({ url: HttpsSourceUrlSchema })

/** What the producer submits. The id and the instant are assigned at the publish boundary. */
export const DailyBriefSubmissionSchema = z.strictObject({
  marketDate: IsoDateSchema,
  /** The model that produced it, as the producer's runtime names it. */
  model: z.string().min(1).max(MAX_BRIEF_MODEL_LENGTH),
  links: z.array(BriefLinkSchema).max(MAX_BRIEF_LINKS),
  recommendations: z.array(BriefRecommendationSchema).max(MAX_BRIEF_RECOMMENDATIONS),
})

export const DailyBriefSchema = DailyBriefSubmissionSchema.extend({
  id: z.string().regex(/^brief-\d{4}-\d{2}-\d{2}$/),
  publishedAt: z.string().datetime(),
})

/** One brief per market date: a second publication for the same date replaces the first. */
export function dailyBriefId(marketDate: string): string {
  return `brief-${marketDate}`
}

export type TradeLeg = z.infer<typeof TradeLegSchema>
export type BriefRecommendation = z.infer<typeof BriefRecommendationSchema>
export type DailyBriefSubmission = z.infer<typeof DailyBriefSubmissionSchema>
export type DailyBrief = z.infer<typeof DailyBriefSchema>
