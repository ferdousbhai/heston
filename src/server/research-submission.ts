import { Type } from 'typebox'

import { MAX_CITED_SOURCE_TITLE_LENGTH, MAX_CITED_SOURCE_URL_LENGTH } from '../domain/market'
import { ResearchCatalystCandidateSchema } from './research-catalyst-output'
import { zodTypeBoxSchema } from './zod-typebox'

/**
 * The model-authored shapes a member's agent submits over MCP and the Worker re-parses at the
 * trust boundary: a candidate dated event and the sources it indexes into. One definition each,
 * so the TypeScript type and the runtime schema cannot drift into parallel copies.
 */
export const CatalystSubmissionSchema = zodTypeBoxSchema(ResearchCatalystCandidateSchema)
export const NativeSearchSource = Type.Object({
  context: Type.String({ minLength: 1, maxLength: 900 }),
  sourceUrl: Type.String({ minLength: 1, maxLength: MAX_CITED_SOURCE_URL_LENGTH }),
  title: Type.String({ minLength: 1, maxLength: MAX_CITED_SOURCE_TITLE_LENGTH }),
}, { additionalProperties: false })
