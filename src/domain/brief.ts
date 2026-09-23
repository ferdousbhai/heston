import { z } from 'zod'

import { CitedSourceUrlSchema } from './https-url'
import { EquitySymbolSchema } from './instrument'
import { IsoDateSchema } from './iso-date'

/*
 * The daily brief: a trade line and a thesis per name, and the morning's market-moving links. It
 * is produced by exactly one writer, the private long-vol Workflow, and delivered through
 * `BriefPublisher`; this schema is the contract that boundary
 * holds the submission to, and the shape every reader of a stored brief gets back. It carries
 * what the site renders and nothing the producer keeps for itself: the structured legs stay in
 * the producer's ledger, and the trade line is the producer's own rendering of them.
 *
 * Every bound below is a rendering envelope for untrusted model text, not a research limit.
 */

export const BRIEF_DIRECTIONS = ['bullish', 'bearish', 'neutral'] as const
/**
 * A thesis is untrusted model markdown rendered in full on the brief card, so this is its
 * rendering envelope: room for an argued page, not an essay the card was never laid out for.
 */
export const MAX_THESIS_LENGTH = 4_096
/** A trade line is one short line: `NVDA 1/16/26: Buy 150c Sell 170c` is the long case. */
export const MAX_TRADE_LABEL_LENGTH = 80
/** A morning's hot page yields a few dozen links at most; more than this is a sweep, not a reading list. */
export const MAX_BRIEF_LINKS = 50
/** High conviction only: a brief that argues more names than this is a screener dump. */
export const MAX_BRIEF_RECOMMENDATIONS = 10
/** A model id as its runtime names it, one line on the cover beside the date. */
export const MAX_BRIEF_MODEL_LENGTH = 80

export const BriefRecommendationSchema = z.strictObject({
  symbol: EquitySymbolSchema,
  direction: z.enum(BRIEF_DIRECTIONS),
  /** The brief's one-line trade, as the producer rendered it from the legs it keeps. */
  trade: z.string().min(1).max(MAX_TRADE_LABEL_LENGTH),
  /** Markdown, rendered by the site's own subset renderer; never HTML. */
  thesis: z.string().min(1).max(MAX_THESIS_LENGTH),
})

export const BriefLinkSchema = z.strictObject({ url: CitedSourceUrlSchema })

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

export type BriefRecommendation = z.infer<typeof BriefRecommendationSchema>
export type DailyBriefSubmission = z.infer<typeof DailyBriefSubmissionSchema>
export type DailyBrief = z.infer<typeof DailyBriefSchema>
