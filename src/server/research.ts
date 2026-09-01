import { CatalystSchema, marketDate, type Catalyst } from '../domain/catalyst'
import { toError } from '../domain/failure'
import { DailyRecommendationsSchema, type DailyRecommendations } from '../domain/market'
import { shouldStartDailyResearch } from '../domain/research-schedule'
import { readMarketStatus } from './brokerage-read-tools'
import { catalystUpsertStatements } from './catalysts'
import { type AppEnv } from './env'
import { dailyRecommendationsId } from './research-contracts'
import { dailyRecommendationsUpsertStatement } from './daily-recommendations-store'
import { brokerApi } from './tastytrade'
import { bindRecommendationCitations } from './research-citation-binding'
import { bindCatalystCandidates } from './research-catalyst-output'
import { recommendationLinkUpsertStatements } from './recommendation-links'
import {
  linksFromCandidates,
  recommendationsFromCandidates,
} from './research-output'
import { dailyResearchAgent, type DailyRecommendationsSubmission } from './research-agent'
import { recommendationLinkKey } from './research-url'

export function shouldStartScheduledResearch(date: Date): boolean {
  return shouldStartDailyResearch(date)
}

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

export interface GenerateDailyRecommendationsOptions {
  persist?: boolean
  requireMarketOpen?: boolean
  runStep?: <T>(name: string, task: () => Promise<T>) => Promise<T>
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

async function resolveResearchInstrumentCatalog(env: AppEnv, now: Date) {
  try {
    const catalog = await brokerApi().resolveResearchInstrumentCatalogFromTastytrade(env, now)
    const result = {
      missingCount: catalog.missingSymbols.length,
      receivedCount: catalog.receivedCount,
      requestedCount: catalog.requestedCount,
      status: 'resolved' as const,
    }
    console.info(JSON.stringify({ event: 'ResearchInstrumentCatalogResolved', ...result }))
    return result
  } catch (cause) {
    const error = toError(cause)
    // Provider bodies and credentials never enter logs; these two labels are controlled
    // by the application and Error constructor, and the durable step records the degraded result.
    const result = {
      errorCode: error?.message.match(/^[A-Za-z][A-Za-z0-9]*(?::\d{3})?/)?.[0] ?? 'UnknownError',
      errorName: error?.name ?? 'Error',
      status: 'unavailable' as const,
    }
    console.error(JSON.stringify({ event: 'ResearchInstrumentCatalogUnavailable', ...result }))
    return result
  }
}

async function persistDailyRecommendations(
  env: AppEnv,
  dailyRecommendations: DailyRecommendations,
  catalysts: readonly Catalyst[],
): Promise<void> {
  if (!env.DB) throw new Error('DailyResearchPersistenceUnavailable')
  // The recommendations and every catalyst learned during their transcript become visible together.
  // Both writes are deterministic upserts, so Workflow replay returns one committed result
  // instead of exposing catalysts from recommendations that later failed their final boundary.
  await env.DB.batch([
    ...catalystUpsertStatements(
      env.DB,
      'daily-research',
      catalysts,
      dailyRecommendations.publishedAt,
    ),
    dailyRecommendationsUpsertStatement(env.DB, dailyRecommendations),
    ...recommendationLinkUpsertStatements(env.DB, dailyRecommendations),
  ])
}

/** One autonomous Pi agent discovers, researches, and submits the typed daily recommendations. */
export async function generateDailyRecommendations(
  env: AppEnv,
  now = new Date(),
  options: GenerateDailyRecommendationsOptions = {},
): Promise<DailyRecommendations> {
  const persist = options.persist ?? true
  const runTask = <T>(name: string, task: () => Promise<T>): Promise<T> => (
    options.runStep ? options.runStep(name, task) : task()
  )
  if (options.requireMarketOpen) {
    const status = await runTask('market-status', () => readMarketStatus(env, now))
    // Tastytrade capitalises the session state ("Open"), which this guard compared verbatim
    // until it cost scheduled recommendations: `DailyResearchMarketNotOpen:Open`. Reading the
    // provider's capitalisation is parsing, not repair, and the snapshot path already
    // lowercases the same field. The raw state still reaches the error, so a genuinely
    // closed market says which state it was in.
    if (status.state.toLowerCase() !== 'open') {
      throw new Error(`DailyResearchMarketNotOpen:${status.state}`)
    }
    await runTask(
      'resolve-instrument-catalog',
      () => resolveResearchInstrumentCatalog(env, now),
    )
  }
  const today = marketDate(now)
  // Workflow replay must keep one transcript identity for every provider turn.
  const gatewayRunId = await runTask('run-id', async () => crypto.randomUUID())
  // Without page reading nothing can be cited, so every recommendation would be refused and empty
  // recommendations would publish as though the day had nothing in it. A missing binding fails closed.
  if (persist && !env.BROWSER) throw new Error('DailyResearch:page-reading-unavailable')
  const agent = await dailyResearchAgent().run(env, {
    now,
    runId: gatewayRunId,
    runStep: options.runStep,
  })
  const { submission } = agent
  const catalystBinding = bindCatalystCandidates(
    submission.catalysts,
    submission.sources,
    agent.retained,
    now,
  )
  if (catalystBinding.rejected.length) {
    throw new Error(`DailyResearchCatalystBinding:${catalystBinding.rejected.join('; ')}`)
  }
  const catalysts = CatalystSchema.array().parse(catalystBinding.catalysts)
  const sources = bindSubmissionSources(submission.sources)
  console.info(JSON.stringify({
    event: 'DailyResearchModelCompleted',
    runId: gatewayRunId,
  }))
  // A recommendation has to point at a page this run actually read and quote it. Both checks read
  // only the retained text and the submission, so a workflow replay reaches the same verdict.
  const bound = bindRecommendationCitations(submission.recommendations, submission.sources, agent.retained)
  console.info(JSON.stringify({
    event: 'DailyResearchCitationBinding',
    kept: bound.recommendations.length,
    pagesRead: agent.retained.size,
    proposed: submission.recommendations.length,
    rejected: bound.rejected,
    runId: gatewayRunId,
  }))
  if (bound.rejected.length) {
    throw new Error(`DailyResearchCitationBinding:${bound.rejected.join('; ')}`)
  }
  const recommendations = recommendationsFromCandidates(submission.recommendations, sources)
  const links = linksFromCandidates(submission.links, sources, recommendations.length)
  // Persist the completion time so replay cannot return a timestamp different from D1.
  const publishedAt = await runTask('published-at', async () => new Date().toISOString())
  const dailyRecommendations = DailyRecommendationsSchema.parse({
    title: submission.title,
    summary: submission.summary,
    regime: submission.regime,
    regimeDetail: submission.regimeDetail,
    recommendations,
    links,
    id: dailyRecommendationsId(today),
    // Dated when the daily recommendations exist, not when the agent run started.
    publishedAt,
    sources: recommendationSourceLinks(recommendations, links),
  })
  if (persist) {
    await runTask('persist-recommendations', async () => {
      await persistDailyRecommendations(env, dailyRecommendations, catalysts)
      return true
    })
  }
  return dailyRecommendations
}
