import { Compile } from 'typebox/compile'

import { marketDate, type Catalyst } from '../domain/catalyst'
import { DailyRecommendationsSchema, type DailyRecommendations } from '../domain/market'
import { RESEARCH_REFRESH_INTERVAL_MINUTES, researchRefreshOpensAt } from '../domain/research-refresh'
import { type AppEnv } from './env'
import { type JsonValue } from '../domain/json-payload'
import {
  DailyRecommendationsSubmissionSchema,
  type DailyRecommendationsSubmission,
} from './research-submission'
import { readResearchPageMarkdown, type RetainedPage } from './research-agent-tools'
import { bindCatalystCandidates } from './research-catalyst-output'
import { bindRecommendationCitations } from './research-citation-binding'
import { catalystUpsertStatements } from './catalysts'
import {
  dailyRecommendationsUpsertStatement,
  readLatestDailyRecommendationsPublishedAt,
} from './daily-recommendations-store'
import { recommendationLinkUpsertStatements } from './recommendation-links'
import { recommendationLinkKey } from './research-url'
import { dailyRecommendationsId, MAX_RESEARCH_PAGE_READS } from './research-contracts'
import { linksFromCandidates, recommendationsFromCandidates } from './research-output'

/*
 * The drop-box for research produced off this Worker, by any member's own agent. What arrives
 * is untrusted model output from a machine this Worker cannot vouch for, so nothing in it
 * establishes a citation by itself: the Worker re-reads every cited page through its own
 * browser at publish time and runs the deterministic binders here. What the site shows is
 * therefore still bound to text this Worker read in this run — the invariant moved to the
 * moment the output crosses the trust boundary, not relaxed for it.
 *
 * A rejection is a result, not an error: the exact reasons return to the submitting agent,
 * which corrects its citations and submits again. Publication is all-or-nothing — partially
 * publishing whatever survived would silently drop the rest behind an apparent success.
 *
 * The refresh interval is enforced here, where it is authoritative, and only mirrored by the
 * site. It is a read-then-write: two members who both pass the gate inside the same window
 * both publish, and the later one stands. That is tolerated rather than locked against because
 * each of those briefs was verified by the binders on its own, so the outcome is the same as
 * two runs an interval apart — and a lease would have to be held across the page reads, which
 * are the slow part.
 */

const SubmissionValidator = Compile(DailyRecommendationsSubmissionSchema)

/** Publish only sources the editor selected for a recommendation or the reader links. */
function recommendationSourceLinks(
  recommendations: DailyRecommendations['recommendations'],
  links: DailyRecommendations['links'],
): DailyRecommendations['sources'] {
  return [
    ...recommendations.flatMap((recommendation) => recommendation.sources),
    ...links.map((item) => ({ label: item.title, url: item.url })),
  ]
}

function bindSubmissionSources(
  sources: readonly DailyRecommendationsSubmission['sources'][number][],
): DailyRecommendations['sources'] {
  return sources.map((candidate, index) => {
    const url = recommendationLinkKey(candidate.sourceUrl)
    if (!url) throw new Error(`DailyResearchOutput:invalid-source-url:${index}`)
    return { label: candidate.title, url }
  })
}

async function persistDailyRecommendations(
  db: D1Database,
  dailyRecommendations: DailyRecommendations,
  catalysts: readonly Catalyst[],
  publishedByUserId: string,
): Promise<void> {
  // The recommendations and every catalyst learned for them become visible together: both
  // writes are deterministic upserts in one batch, so a reader never sees catalysts from a
  // brief that failed its final boundary.
  await db.batch([
    ...catalystUpsertStatements(db, 'daily-research', catalysts, dailyRecommendations.publishedAt),
    dailyRecommendationsUpsertStatement(db, dailyRecommendations, publishedByUserId),
    ...recommendationLinkUpsertStatements(db, dailyRecommendations),
  ])
}

export type DailyRecommendationsPublication =
  | {
    catalystCount: number
    id: string
    linkCount: number
    recommendationCount: number
    status: 'published'
  }
  | { rejected: string[]; status: 'rejected' }

export interface PublishSubmissionOptions {
  now?: Date
  /**
   * The account publishing this brief. Required, and stored privately beside the row: any
   * member's agent may replace the public brief, so every publication has a member behind it
   * that the owner can reach. It never reaches a reader -- what readers see is the byline the
   * member chose for the brief, if they chose one.
   */
  publishedByUserId: string
}

/** Indices the submission actually leans on; only those pages are worth the Worker's read. */
function citedSourceIndices(submission: DailyRecommendationsSubmission): Set<number> {
  const indices = new Set<number>()
  for (const recommendation of submission.recommendations) {
    for (const index of recommendation.sourceIndices) indices.add(index)
    for (const evidence of recommendation.evidence) indices.add(evidence.sourceIndex)
  }
  for (const link of submission.links) indices.add(link.sourceIndex)
  for (const catalyst of submission.catalysts) indices.add(catalyst.sourceIndex)
  return indices
}

export async function publishSubmittedDailyRecommendations(
  env: AppEnv,
  untrustedSubmission: JsonValue,
  options: PublishSubmissionOptions,
): Promise<DailyRecommendationsPublication> {
  const browser = env.BROWSER
  // Without page reading nothing can be verified, so nothing may publish. Fail closed.
  if (!browser) throw new Error('DailyResearchPublish:page-reading-unavailable')
  const now = options.now ?? new Date()
  const submission = SubmissionValidator.Parse(untrustedSubmission)
  // An empty brief is a decision not to publish, not a publication. Refusing it here keeps
  // "the site shows nothing new today" distinguishable from "a run published nothing".
  if (submission.recommendations.length === 0) {
    return { rejected: ['no recommendations submitted; a day without a brief publishes nothing'], status: 'rejected' }
  }
  // Nothing verified here can be kept without the store, so fail closed before reading a page.
  const db = env.DB
  if (!db) throw new Error('DailyResearchPersistenceUnavailable')
  // Also before any page is read: a run that cannot publish yet should learn so before it
  // spends the Worker's browser budget on citations it will have to bring back later.
  const latestPublishedAt = await readLatestDailyRecommendationsPublishedAt(db)
  const opensAt = latestPublishedAt === undefined ? undefined : researchRefreshOpensAt(latestPublishedAt)
  if (opensAt && now.getTime() < opensAt.getTime()) {
    return {
      rejected: [
        `refresh interval: the current brief was published at ${latestPublishedAt}; `
        + `a brief stands for ${RESEARCH_REFRESH_INTERVAL_MINUTES} minutes and a new one `
        + `may be published from ${opensAt.toISOString()}`,
      ],
      status: 'rejected',
    }
  }

  const rejected: string[] = []
  const pageKeys = new Set<string>()
  for (const index of citedSourceIndices(submission)) {
    const sourceUrl = submission.sources[index]?.sourceUrl
    // An index past the end of sources has no page to read; the binders reject the citation.
    if (sourceUrl === undefined) continue
    const key = recommendationLinkKey(sourceUrl)
    if (key === undefined) rejected.push(`source ${index}: not a readable https page address`)
    else pageKeys.add(key)
  }
  if (pageKeys.size > MAX_RESEARCH_PAGE_READS) {
    return {
      rejected: [`cites ${pageKeys.size} pages; at most ${MAX_RESEARCH_PAGE_READS} are read in one run`],
      status: 'rejected',
    }
  }
  if (rejected.length) return { rejected, status: 'rejected' }

  const retained = new Map<string, RetainedPage>()
  for (const key of pageKeys) {
    const markdown = await readResearchPageMarkdown(browser, key)
    if (markdown === undefined) rejected.push(`page did not open: ${key}`)
    else retained.set(key, { markdown, readAt: now.toISOString() })
  }
  if (rejected.length) return { rejected, status: 'rejected' }

  const catalystBinding = bindCatalystCandidates(submission.catalysts, submission.sources, retained, now)
  const citationBinding = bindRecommendationCitations(submission.recommendations, submission.sources, retained)
  if (catalystBinding.rejected.length || citationBinding.rejected.length) {
    return { rejected: [...catalystBinding.rejected, ...citationBinding.rejected], status: 'rejected' }
  }

  const catalysts = catalystBinding.catalysts
  const sources = bindSubmissionSources(submission.sources)
  const recommendations = recommendationsFromCandidates(citationBinding.recommendations, sources)
  const links = linksFromCandidates(submission.links, sources, recommendations.length)
  const dailyRecommendations: DailyRecommendations = DailyRecommendationsSchema.parse({
    // Absent when the member named none: the stored JSON carries no byline at all, and the
    // cover shows nothing where it would go rather than guessing at a name from the account.
    byline: submission.byline,
    id: dailyRecommendationsId(marketDate(now)),
    links,
    model: submission.model,
    publishedAt: now.toISOString(),
    recommendations,
    regime: submission.regime,
    regimeDetail: submission.regimeDetail,
    sources: recommendationSourceLinks(recommendations, links),
    summary: submission.summary,
    title: submission.title,
  })
  // The site is the publication. The channel that once mirrored it is retired.
  await persistDailyRecommendations(db, dailyRecommendations, catalysts, options.publishedByUserId)
  return {
    catalystCount: catalysts.length,
    id: dailyRecommendations.id,
    linkCount: links.length,
    recommendationCount: recommendations.length,
    status: 'published',
  }
}
