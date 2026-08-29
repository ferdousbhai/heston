import {
  ResearchIdeaSchema,
  ResearchReadingLinkSchema,
  type ResearchBrief,
} from '../domain/market'
import { type DailyResearchSubmission } from './research-agent'

type ResearchIdeaCandidate = DailyResearchSubmission['ideas'][number]
type ReadingLinkCandidate = DailyResearchSubmission['readingList'][number]
type ProposedPlay = NonNullable<ResearchIdeaCandidate['play']>

function playLabel(symbol: string, play: ProposedPlay): string {
  const [, month, day] = play.expiration.split('-').map(Number)
  const optionType = play.optionType === 'call' ? 'c' : 'p'
  return `${symbol} ${play.strike}${optionType} ${month}/${day}`
}

/** Resolve the model's source references and render its typed option expression unchanged. */
export function researchIdeas(
  ideas: readonly ResearchIdeaCandidate[],
  sources: readonly ResearchBrief['sources'][number][],
): ResearchBrief['ideas'] {
  return ideas.map((idea, ideaIndex) => {
    const selected = idea.sourceIndices.map((index) => {
      const source = sources[index]
      if (!source) throw new Error(`DailyResearchOutput:missing-idea-source:${ideaIndex}:${index}`)
      return source
    })
    const {
      sourceIndices: _sourceIndices,
      ...publicIdea
    } = idea
    return ResearchIdeaSchema.parse({
      ...publicIdea,
      play: idea.play ? playLabel(idea.symbol, idea.play) : null,
      sources: selected,
    })
  })
}

/** Bind the editor's ranked reading picks to application-owned evidence URLs. */
export function readingListFromCandidates(
  value: readonly ReadingLinkCandidate[],
  sources: readonly ResearchBrief['sources'][number][],
): ResearchBrief['readingList'] {
  return value.map((candidate, candidateIndex) => {
    const source = sources[candidate.sourceIndex]
    if (!source) throw new Error(`DailyResearchOutput:missing-reading-source:${candidateIndex}:${candidate.sourceIndex}`)
    return ResearchReadingLinkSchema.parse({
      reason: candidate.description,
      title: candidate.title,
      url: source.url,
    })
  })
}
