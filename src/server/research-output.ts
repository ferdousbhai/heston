import {
  RecommendationSchema,
  RecommendationLinkSchema,
  type DailyRecommendations,
  type ResearchSourceLink,
} from '../domain/market'
import { type DailyRecommendationsSubmission } from './research-submission'

type RecommendationCandidate = DailyRecommendationsSubmission['recommendations'][number]
type RecommendationLinkCandidate = DailyRecommendationsSubmission['links'][number]

/** Resolve the model's source references and preserve its validated, non-executable order. */
export function recommendationsFromCandidates(
  recommendations: readonly RecommendationCandidate[],
  sources: readonly ResearchSourceLink[],
): DailyRecommendations['recommendations'] {
  return recommendations.map((recommendation, recommendationIndex) => {
    const selected = recommendation.sourceIndices.map((index) => {
      const source = sources[index]
      if (!source) {
        throw new Error(`DailyResearchOutput:missing-recommendation-source:${recommendationIndex}:${index}`)
      }
      return source
    })
    const {
      evidence,
      sourceIndices: _sourceIndices,
      ...publicRecommendation
    } = recommendation
    // The quote the binder matched travels with the recommendation, addressed by the page's own
    // https URL rather than by an index into a list a later reader does not have. That is what
    // `challenge_recommendation` re-reads; an index would have made the check unresolvable.
    const citedEvidence = evidence.map((quoted) => {
      const source = sources[quoted.sourceIndex]
      if (!source) {
        throw new Error(`DailyResearchOutput:missing-evidence-source:${recommendationIndex}:${quoted.sourceIndex}`)
      }
      return { quote: quoted.quote, url: source.url }
    })
    return RecommendationSchema.parse({
      ...publicRecommendation,
      evidence: citedEvidence,
      sources: selected,
    })
  })
}

/** Bind the editor's ranked reader links to application-owned evidence URLs. */
export function linksFromCandidates(
  value: readonly RecommendationLinkCandidate[],
  sources: readonly ResearchSourceLink[],
  recommendationCount: number,
): DailyRecommendations['links'] {
  if (value.length !== recommendationCount) {
    throw new Error(`DailyResearchOutput:link-count-mismatch:${recommendationCount}:${value.length}`)
  }
  const recommendationIndices = new Set(value.map((candidate) => candidate.recommendationIndex))
  if (recommendationIndices.size !== recommendationCount) {
    throw new Error('DailyResearchOutput:duplicate-recommendation-link')
  }
  for (let recommendationIndex = 0; recommendationIndex < recommendationCount; recommendationIndex += 1) {
    if (!recommendationIndices.has(recommendationIndex)) {
      throw new Error(`DailyResearchOutput:missing-recommendation-link:${recommendationIndex}`)
    }
  }
  return [...value].sort((left, right) => left.recommendationIndex - right.recommendationIndex)
    .map((candidate, candidateIndex) => {
      const source = sources[candidate.sourceIndex]
      if (!source) {
        throw new Error(`DailyResearchOutput:missing-link-source:${candidateIndex}:${candidate.sourceIndex}`)
      }
      const link = {
        description: candidate.description,
        title: candidate.title,
        url: source.url,
      }
      return RecommendationLinkSchema.parse(candidate.previewImageUrl
        ? { ...link, previewImageUrl: candidate.previewImageUrl }
        : link)
    })
}
