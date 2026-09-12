import { type DailyRecommendationsSubmission } from './research-submission'
import { type RetainedPage } from './research-agent-tools'
import { recommendationLinkKey } from './research-url'

/*
 * A citation is bound to what this Worker actually read. Native web search runs inside the
 * provider, so a page the model reports opening leaves nothing here to check; a page read
 * through read_page leaves its text, and a recommendation has to point at one of those and quote it.
 *
 * Two checks, both deterministic. A cited source must be a page read this run, and each
 * quote must appear in that page's retained text. Neither asks a model whether a claim is
 * supported — the earlier attempt did, and a model vouching for a model is the self-check
 * this pipeline already learned to distrust.
 *
 * What this bounds is fabrication, not interpretation: a real sentence can still be quoted
 * beside a wrong inference. That residual belongs to the reader, which is why
 * the quote travels with the recommendation rather than being discarded after the check.
 */

export type CitationBinding = {
  recommendations: DailyRecommendationsSubmission['recommendations']
  rejected: string[]
}

/**
 * Markdown renders the same sentence many ways; only its words decide a match. Exported because
 * every surface that binds a quote to a page this Worker read must normalize it identically --
 * a second copy of these replacements is a second, quietly different definition of "verbatim".
 */
export function normalizedCitationText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function bindRecommendationCitations(
  recommendations: DailyRecommendationsSubmission['recommendations'],
  sources: readonly { sourceUrl: string }[],
  retained: ReadonlyMap<string, RetainedPage>,
): CitationBinding {
  const pages = new Map([...retained].map(([url, page]) => [recommendationLinkKey(url) ?? url, normalizedCitationText(page.markdown)]))
  const readPage = (index: number | undefined): string | undefined => {
    const cited = index === undefined ? undefined : sources[index]?.sourceUrl
    const key = cited === undefined ? undefined : recommendationLinkKey(cited)
    return key === undefined ? undefined : pages.get(key)
  }
  const kept: CitationBinding['recommendations'] = []
  const rejected: string[] = []
  for (const recommendation of recommendations) {
    // `some`, not `find`: an index past the end of sources maps to undefined, and a `find`
    // that matches it returns undefined too — indistinguishable from nothing failing. Such an
    // recommendation used to pass here and then throw downstream, taking the daily output with it.
    if (recommendation.sourceIndices.some((index) => readPage(index) === undefined)) {
      rejected.push(`${recommendation.symbol}: cites a page this run never read`)
      continue
    }
    // A quote only vouches for a source the recommendation actually leans on.
    if (recommendation.evidence.some((evidence) => !recommendation.sourceIndices.includes(evidence.sourceIndex))) {
      rejected.push(`${recommendation.symbol}: quotes a source it does not cite`)
      continue
    }
    // Naming the failing quote costs nothing here and saved attempts elsewhere: a live run
    // burned its last correction guessing which of three quotes the server could not find.
    const unquoted = recommendation.evidence.find((evidence) => {
      const page = readPage(evidence.sourceIndex)
      return page === undefined || !page.includes(normalizedCitationText(evidence.quote))
    })
    if (unquoted) {
      rejected.push(`${recommendation.symbol}: quote absent from its source: "${unquoted.quote.slice(0, 80)}"`)
      continue
    }
    kept.push(recommendation)
  }
  return { recommendations: kept, rejected }
}
