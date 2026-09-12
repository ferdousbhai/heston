import { type Static, Type } from 'typebox'

import { EquitySymbolType } from '../domain/instrument'
import { MAX_RESEARCH_MODEL_NAME_LENGTH } from '../domain/market'
import { ActionableRecommendedOrderSchema } from '../domain/recommended-order'
import { ResearchCatalystCandidateSchema } from './research-catalyst-output'
import { zodTypeBoxSchema } from './zod-typebox'

// The daily surface is intentionally selective, not a screener dump.
export const MAX_DAILY_RECOMMENDATIONS = 3
// One quote per source a recommendation leans on is enough to bind it; more is padding.
const MAX_EVIDENCE_PER_RECOMMENDATION = 4

const SourceIndices = Type.Array(Type.Integer({ minimum: 0 }), { minItems: 1 })
export const RecommendedOrderSubmissionSchema = zodTypeBoxSchema(ActionableRecommendedOrderSchema)
// Exported because the catalyst recording tool takes the same two shapes: a candidate dated
// event and the sources it indexes into. One definition, so an agent that can write a brief's
// catalysts already knows how to record one, and neither shape can drift from the other.
export const CatalystSubmissionSchema = zodTypeBoxSchema(ResearchCatalystCandidateSchema)
export const NativeSearchSource = Type.Object({
  context: Type.String({ minLength: 1, maxLength: 900 }),
  sourceUrl: Type.String({ minLength: 1, maxLength: 2_000 }),
  title: Type.String({ minLength: 1, maxLength: 180 }),
}, { additionalProperties: false })

/**
 * The one model-authored contract in the daily pipeline, submitted from an agent on a member's
 * own machine through the MCP publish drop-box. The Worker parses it with this same
 * schema, so its static TypeScript type and runtime boundary cannot drift into parallel
 * schemas. Its copy-length budgets keep untrusted prose inside rendering envelopes; they are
 * not evidence caps.
 */
export const DailyRecommendationsSubmissionSchema = Type.Object({
  catalysts: Type.Array(CatalystSubmissionSchema),
  model: Type.String({
    description: 'The model you are running as, as your runtime names it (for example '
      + '"claude-opus-5"). Published with the brief so readers know what produced it.',
    maxLength: MAX_RESEARCH_MODEL_NAME_LENGTH,
    minLength: 1,
  }),
  sources: Type.Array(NativeSearchSource),
  title: Type.String({ minLength: 1, maxLength: 100 }),
  summary: Type.String({ minLength: 1, maxLength: 360 }),
  regime: Type.String({ minLength: 1, maxLength: 80 }),
  regimeDetail: Type.String({ minLength: 1, maxLength: 180 }),
  recommendations: Type.Array(Type.Object({
    description: Type.String({ minLength: 1, maxLength: 360 }),
    // Quoted verbatim from a cited page. The publish boundary re-reads each cited page and
    // matches every quote against the text it retained, so a recommendation cannot assert a
    // date or number its own source does not contain.
    evidence: Type.Array(Type.Object({
      quote: Type.String({ minLength: 1, maxLength: 300 }),
      sourceIndex: Type.Integer({ minimum: 0 }),
    }, { additionalProperties: false }), { minItems: 1, maxItems: MAX_EVIDENCE_PER_RECOMMENDATION }),
    direction: Type.Union([Type.Literal('bullish'), Type.Literal('bearish')]),
    headline: Type.String({ minLength: 1, maxLength: 100 }),
    recommendedOrder: RecommendedOrderSubmissionSchema,
    risk: Type.String({ minLength: 1, maxLength: 240 }),
    sourceIndices: SourceIndices,
    symbol: EquitySymbolType,
  }, { additionalProperties: false }), { maxItems: MAX_DAILY_RECOMMENDATIONS }),
  links: Type.Array(Type.Object({
    description: Type.String({ minLength: 1, maxLength: 180 }),
    previewImageUrl: Type.Optional(Type.String({ maxLength: 2_000, pattern: '^https://' })),
    recommendationIndex: Type.Integer({ minimum: 0, maximum: MAX_DAILY_RECOMMENDATIONS - 1 }),
    sourceIndex: Type.Integer({ minimum: 0 }),
    title: Type.String({ minLength: 1, maxLength: 180 }),
  }, { additionalProperties: false }), { maxItems: MAX_DAILY_RECOMMENDATIONS }),
}, { additionalProperties: false })

export type DailyRecommendationsSubmission = Static<typeof DailyRecommendationsSubmissionSchema>
