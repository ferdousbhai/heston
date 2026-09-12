import { type AgentTool } from '../domain/agent-tool'
import { Type } from 'typebox'

import { equitySymbolFromModelText, ModelTextEquitySymbolType } from '../domain/instrument'
import { type RecommendationVerification } from '../domain/market'
import { RESEARCH_REFRESH_INTERVAL_MINUTES, researchRefreshOpensAt } from '../domain/research-refresh'
import { textResult } from './agent-tool-result'
import {
  readLatestDailyRecommendations,
  writeRecommendationVerification,
} from './daily-recommendations-store'
import { type AppEnv } from './env'
import { readResearchPageMarkdown } from './research-agent-tools'
import { normalizedCitationText } from './research-citation-binding'

/*
 * Putting a published recommendation back against its own sources.
 *
 * The publish boundary binds every quote to text this Worker read in that run, which is a
 * claim about one moment. A page is edited, retitled, paywalled or withdrawn afterwards, and
 * the brief goes on asserting what it asserted -- so the standing brief is the one thing here
 * whose evidence ages while it is on display. This re-reads the recommendation's own stored
 * evidence URLs through the Worker's browser and asks the identical question the binder asked,
 * with the identical normalisation, then records the answer on the recommendation.
 *
 * No caller input reaches a page. The caller names a symbol; every URL read is one this Worker
 * already published, so a challenge cannot be steered at an address of the caller's choosing.
 *
 * The work is page reads, which is why a check is bounded by the same interval a brief stands
 * for: a repeat inside that window returns the stored verification and reads nothing. A
 * recommendation published before evidence was retained says it cannot be re-verified, because
 * "no quotes to check" and "every quote still stands" are not the same answer.
 */

const ChallengeParameters = Type.Object({
  symbol: ModelTextEquitySymbolType,
}, { additionalProperties: false })

export type RecommendationChallenge =
  | { status: 'no_brief' }
  | { briefId: string; status: 'not_recommended'; symbol: string }
  | { briefId: string; reason: string; status: 'unverifiable'; symbol: string }
  | { briefId: string; status: 'superseded'; symbol: string }
  | {
    briefId: string
    /** False when the stored verification is still inside its window and no page was read. */
    ran: boolean
    status: 'checked'
    symbol: string
    verification: RecommendationVerification
  }

export async function challengeRecommendation(
  env: AppEnv,
  symbol: string,
  now = new Date(),
): Promise<RecommendationChallenge> {
  const db = env.DB
  if (!db) throw new Error('RecommendationChallenge:store-unavailable')
  const browser = env.BROWSER
  // Fail closed exactly as the publish boundary does: without this Worker's own read of the
  // page there is nothing to check a quote against, and anything else it could answer from
  // would be a verification of nothing.
  if (!browser) throw new Error('RecommendationChallenge:page-reading-unavailable')

  const brief = await readLatestDailyRecommendations(db)
  if (!brief) return { status: 'no_brief' }
  const recommendationIndex = brief.recommendations.findIndex((candidate) => candidate.symbol === symbol)
  const recommendation = brief.recommendations[recommendationIndex]
  if (!recommendation) return { briefId: brief.id, status: 'not_recommended', symbol }
  if (!recommendation.evidence?.length) {
    return {
      briefId: brief.id,
      reason: 'cannot be re-verified: published before evidence was retained',
      status: 'unverifiable',
      symbol,
    }
  }

  // `verification.checkedAt` is the receipt, and the window is the one a brief stands for: a
  // second challenge inside it would spend the same page reads to answer the same question.
  const standing = recommendation.verification
  if (standing && now.getTime() < researchRefreshOpensAt(standing.checkedAt).getTime()) {
    return { briefId: brief.id, ran: false, status: 'checked', symbol, verification: standing }
  }

  const reasons: string[] = []
  // One read per page, not per quote: a recommendation may lean on two sentences of the same
  // article, and a page that will not open is one fact about that page, said once.
  const pages = new Map<string, string | undefined>()
  for (const quoted of recommendation.evidence) {
    if (pages.has(quoted.url)) continue
    const markdown = await readResearchPageMarkdown(browser, quoted.url)
    pages.set(quoted.url, markdown === undefined ? undefined : normalizedCitationText(markdown))
    if (markdown === undefined) reasons.push(`source no longer opens: ${quoted.url}`)
  }
  for (const quoted of recommendation.evidence) {
    const page = pages.get(quoted.url)
    // A page that did not open has already been named; not finding its quote is the same fact.
    if (page === undefined) continue
    if (!page.includes(normalizedCitationText(quoted.quote))) {
      reasons.push(`quote no longer in ${quoted.url}: "${quoted.quote}"`)
    }
  }

  const verification: RecommendationVerification = {
    checkedAt: now.toISOString(),
    reasons,
    status: reasons.length ? 'stale' : 'holds',
  }
  const written = await writeRecommendationVerification(
    db,
    { briefId: brief.id, publishedAt: brief.publishedAt, recommendationIndex, symbol },
    verification,
  )
  // A brief replaced while these pages were being read is a different brief, whatever its id:
  // the check was run against evidence nobody is publishing any more, so it is reported and
  // not stored rather than attached to text it was never run on.
  if (!written) return { briefId: brief.id, status: 'superseded', symbol }
  return { briefId: brief.id, ran: true, status: 'checked', symbol, verification }
}

export function createRecommendationChallengeTool(
  env: AppEnv,
  now = new Date(),
): AgentTool<typeof ChallengeParameters, RecommendationChallenge | { error: string }> {
  return {
    description: 'Re-read the sources behind one symbol in the published brief and record '
      + 'whether its quotes still stand. The server reads each page it quoted and matches the '
      + 'quote against that text; the finding is stored on the brief and shown to readers. A '
      + 'recommendation published before evidence was retained cannot be re-verified. One check '
      + `per symbol per ${RESEARCH_REFRESH_INTERVAL_MINUTES} minutes; a repeat inside that `
      + 'window returns the stored result.',
    execute: async (_toolCallId, params) => {
      const symbol = equitySymbolFromModelText(params.symbol)
      // The refusal names the check, not the value it refused.
      if (symbol === undefined) return textResult({ error: 'not a ticker symbol' })
      return textResult(await challengeRecommendation(env, symbol, now))
    },
    label: 'Challenging a recommendation',
    name: 'challenge_recommendation',
    parameters: ChallengeParameters,
  }
}
