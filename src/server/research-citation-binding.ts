import { sift, type Verdict } from '../domain/sift'
import { type DailyResearchSubmission } from './research-agent'
import { retentionKey, type RetainedPage } from './research-agent-tools'

/*
 * A citation is bound to what this Worker actually read. Native web search runs inside the
 * provider, so a page the model reports opening leaves nothing here to check; a page read
 * through read_page leaves its text, and an idea has to point at one of those and quote it.
 *
 * Two checks, both deterministic. A cited source must be a page read this run, and each
 * quote must appear in that page's retained text. Neither asks a model whether a claim is
 * supported — the earlier attempt did, and a model vouching for a model is the self-check
 * this pipeline already learned to distrust.
 *
 * What this bounds is fabrication, not interpretation: a real sentence can still be quoted
 * beside a wrong inference. That residual belongs to the reader of the brief, which is why
 * the quote travels with the idea rather than being discarded after the check.
 */

export type CitationBinding = {
  ideas: DailyResearchSubmission['ideas']
  rejected: string[]
}

/** Markdown renders the same sentence many ways; only its words decide a match. */
function normalized(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function bindBriefCitations(
  ideas: DailyResearchSubmission['ideas'],
  sources: readonly { sourceUrl: string }[],
  retained: ReadonlyMap<string, RetainedPage>,
): CitationBinding {
  const pages = new Map([...retained].map(([url, page]) => [retentionKey(url) ?? url, normalized(page.markdown)]))
  const readPage = (index: number | undefined): string | undefined => {
    const cited = index === undefined ? undefined : sources[index]?.sourceUrl
    const key = cited === undefined ? undefined : retentionKey(cited)
    return key === undefined ? undefined : pages.get(key)
  }
  const sifted = sift(ideas, (idea): Verdict<DailyResearchSubmission['ideas'][number]> => {
    // `some`, not `find`: an index past the end of sources maps to undefined, and a `find`
    // that matches it returns undefined too — indistinguishable from nothing failing. Such an
    // idea used to pass here and then throw downstream, taking the whole brief with it.
    if (idea.sourceIndices.some((index) => readPage(index) === undefined)) {
      return { rejected: `${idea.symbol}: cites a page this run never read` }
    }
    // A quote only vouches for a source the idea actually leans on.
    if (idea.evidence.some((evidence) => !idea.sourceIndices.includes(evidence.sourceIndex))) {
      return { rejected: `${idea.symbol}: quotes a source it does not cite` }
    }
    const unquoted = idea.evidence.some((evidence) => {
      const page = readPage(evidence.sourceIndex)
      return page === undefined || !page.includes(normalized(evidence.quote))
    })
    return unquoted
      ? { rejected: `${idea.symbol}: quote absent from its source` }
      : { kept: idea }
  })
  return { ideas: sifted.kept, rejected: sifted.rejected }
}
