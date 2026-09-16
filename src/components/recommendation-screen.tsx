import { useEffect, useState } from 'react'
import { ArrowUpRight, ChevronLeft, ChevronRight, ShieldAlert, ShieldCheck } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#/components/ui/card'
import { Spinner } from '#/components/ui/spinner'
import { loadAgentConnection } from '../data/agent-connection'
import { loadChannelArchivePage } from '../data/channel-archive'
import { loadPreviousDailyRecommendations } from '../data/recommendation-archive'
import { type AgentConnection } from '../domain/agent-connection'
import { type ChannelPost } from '../domain/channel-post'
import { type DailyRecommendations, type RecommendationVerification } from '../domain/market'
import { recommendedOrderLabel } from '../domain/recommended-order'
import {
  RESEARCH_REFRESH_INTERVAL_MINUTES,
  researchRefreshOpen,
  researchRefreshOpensAt,
} from '../domain/research-refresh'
import { CopyBlock } from './copy-block'

// The run publishes at a time of day, not on a day, so the issue line carries the time too.
const issueDate = new Intl.DateTimeFormat('en-US', {
  day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short', timeZone: 'America/New_York', timeZoneName: 'short', year: 'numeric',
})
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
/**
 * What a reader tells their agent, whatever agent that is. It names the tool rather than only
 * the prompt: every MCP client supports tools, and the tool's own description carries the
 * contract, while prompts are a client feature some agents do not surface. The names are the
 * ones `mcp.ts` registers.
 */
const DAILY_RESEARCH_ASK = 'Research today\'s market and publish a fresh brief to Spice with its '
  + 'publish_daily_recommendations tool. If your client lists Spice\'s prompts, run daily_research.'

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? '' : 's'}`
}

/** How long ago a brief was published, to the precision a reader would say it in. */
export function briefAge(now: Date, publishedAt: string): string {
  const elapsed = now.getTime() - Date.parse(publishedAt)
  if (!Number.isFinite(elapsed)) throw new Error('RecommendationScreen:invalid-published-at')
  if (elapsed < MINUTE_MS) return 'just now'
  if (elapsed < HOUR_MS) return `${plural(Math.floor(elapsed / MINUTE_MS), 'minute')} ago`
  if (elapsed < DAY_MS) return `${plural(Math.floor(elapsed / HOUR_MS), 'hour')} ago`
  return `${plural(Math.floor(elapsed / DAY_MS), 'day')} ago`
}

/** Until a fresh brief may be generated; the interval is minutes, so minutes is the unit. */
export function refreshCountdown(now: Date, opensAt: Date): string {
  const remaining = opensAt.getTime() - now.getTime()
  if (remaining <= 0) return 'now'
  return `in about ${plural(Math.ceil(remaining / MINUTE_MS), 'minute')}`
}

/**
 * A clock that ticks on the minute unless a test pins it. The age and the countdown are both
 * stated to the minute, so that is how often they can move.
 */
function useMinuteClock(fixedNow?: Date): Date {
  const [now, setNow] = useState(() => fixedNow ?? new Date())
  useEffect(() => {
    if (fixedNow) return
    const timer = window.setInterval(() => setNow(new Date()), MINUTE_MS)
    return () => window.clearInterval(timer)
  }, [fixedNow])
  return now
}

/**
 * Whether this member's agent has reached Spice, read only when there is a run to offer. A
 * visitor who is not signed in is told the first step rather than asked; a check that fails
 * says so and still offers the Connect tab, because the tab is the answer either way.
 */
function AgentConnectionStep({ onConnect, signedIn }: { onConnect: () => void; signedIn: boolean }) {
  const [connection, setConnection] = useState<AgentConnection | 'checking' | 'unavailable'>('checking')
  useEffect(() => {
    if (!signedIn) return
    const controller = new AbortController()
    loadAgentConnection(controller.signal)
      .then((agent) => { if (!controller.signal.aborted) setConnection(agent) })
      .catch(() => { if (!controller.signal.aborted) setConnection('unavailable') })
    return () => controller.abort()
  }, [signedIn])

  const connectButton = (
    <Button onClick={onConnect} size="sm" type="button" variant="outline">Connect an agent</Button>
  )
  if (!signedIn) {
    return (
      <>
        <p>Sign in, then point your own agent at Spice from the Connect tab.</p>
        {connectButton}
      </>
    )
  }
  if (connection === 'checking') return <p className="research-run-checking" role="status"><Spinner />Checking for your agent</p>
  if (connection === 'unavailable') {
    return (
      <>
        <p>Whether your agent is connected could not be checked. If it is not, the Connect tab is where to start.</p>
        {connectButton}
      </>
    )
  }
  if (!connection.connected) {
    return (
      <>
        <p>No agent has reached Spice from your account yet.</p>
        {connectButton}
      </>
    )
  }
  return (
    <p className="research-run-connected">
      Your agent is connected
      {connection.lastSeenAt && (
        <>
          {' '}&middot; last reached Spice{' '}
          <time dateTime={connection.lastSeenAt}>{issueDate.format(new Date(connection.lastSeenAt))}</time>
        </>
      )}
      .
    </p>
  )
}

/**
 * The brief is produced by whoever asks their own agent for it; nothing on the site waits on a
 * schedule or on anyone's laptop. This panel says what the current brief is -- which model, how
 * long ago -- and, once the refresh interval has passed, how to replace it. The interval is the
 * server's; the panel only mirrors it so a reader is not sent to a refusal.
 */
function ResearchRunPanel({
  latest,
  now,
  onConnect,
  signedIn,
}: {
  latest?: DailyRecommendations
  now: Date
  onConnect: () => void
  signedIn: boolean
}) {
  // Set exactly while a standing brief still holds the window shut, which is also the branch.
  const opensAt = latest && !researchRefreshOpen(latest.publishedAt, now)
    ? researchRefreshOpensAt(latest.publishedAt)
    : undefined
  return (
    <section aria-labelledby="research-run-title" aria-live="polite" className="research-run-panel" id="research-run">
      <h2 id="research-run-title">{latest ? 'Generate a fresh brief' : 'No brief yet'}</h2>
      <p className="research-run-standing">
        {latest
          ? (
              <>
                This brief was generated {briefAge(now, latest.publishedAt)}
                {latest.model ? <> by <strong>{latest.model}</strong></> : '; the model was not recorded'}.
                Any member&apos;s agent can produce the next one, and Spice verifies every citation before it replaces this.
              </>
            )
          : 'Nothing has been published yet. The first brief is whoever asks their agent for it.'}
      </p>
      {opensAt
        ? (
            <p className="research-run-wait">
              A brief stands for {RESEARCH_REFRESH_INTERVAL_MINUTES} minutes. A fresh one can be generated{' '}
              <time dateTime={opensAt.toISOString()}>{refreshCountdown(now, opensAt)}</time>.
            </p>
          )
        : (
            <ol className="research-run-steps">
              <li>
                <strong>Connect your agent.</strong>
                <AgentConnectionStep onConnect={onConnect} signedIn={signedIn} />
              </li>
              <li>
                <strong>Ask it for a fresh brief.</strong>
                <p>
                  Any agent that speaks MCP can do this. Spice&apos;s <code>daily_research</code> prompt walks
                  it through the research and the publish step, and the publish tool describes what it
                  will and will not accept, so an agent that does not surface prompts still has what it needs.
                </p>
                <CopyBlock label="Ask your agent" value={DAILY_RESEARCH_ASK} />
              </li>
            </ol>
          )}
    </section>
  )
}

/**
 * What a later re-read of this recommendation's own sources found. A `stale` finding contradicts
 * the card it sits on, so it is drawn as loudly as the risk line and carries the server's exact
 * reasons; a finding that holds is one quiet line, because "still true" is not news.
 */
function RecommendationVerificationNote({ verification }: { verification: RecommendationVerification }) {
  const checkedAt = (
    <time dateTime={verification.checkedAt}>{issueDate.format(new Date(verification.checkedAt))}</time>
  )
  if (verification.status === 'holds') {
    return (
      <CardFooter className="recommendation-verification">
        <p>Sources re-checked {checkedAt}</p>
      </CardFooter>
    )
  }
  return (
    <CardFooter className="recommendation-verification">
      <Alert variant="destructive">
        <ShieldAlert aria-hidden="true" />
        <AlertTitle>No longer supported by its sources &middot; checked {checkedAt}</AlertTitle>
        <AlertDescription>
          <ul>
            {verification.reasons.map((reason) => <li key={reason}>{reason}</li>)}
          </ul>
        </AlertDescription>
      </Alert>
    </CardFooter>
  )
}

function RecommendationNavigation({
  index,
  loading,
  onNewer,
  onOlder,
  olderDisabled,
}: {
  index: number
  loading: boolean
  onNewer: () => void
  onOlder: () => void
  olderDisabled: boolean
}) {
  return (
    <nav aria-label="Recommendation archive" className="recommendation-navigation">
      <Button disabled={olderDisabled || loading} onClick={onOlder} size="sm" type="button" variant="ghost">
        {loading ? <Spinner data-icon="inline-start" /> : <ChevronLeft data-icon="inline-start" />}
        Previous
      </Button>
      {index > 0 && (
        <Button disabled={loading} onClick={onNewer} size="sm" type="button" variant="ghost">
          Next<ChevronRight data-icon="inline-end" />
        </Button>
      )}
    </nav>
  )
}

/**
 * What survives of the Telegram channel this site replaced. Telegram deleted the channel's
 * messages after a month until March 2026, so the archive begins there and ends with the
 * channel's last post; it is finite and read newest first, a page per tap.
 */
function ChannelArchive() {
  const [posts, setPosts] = useState<ChannelPost[]>([])
  const [nextBefore, setNextBefore] = useState<number>()
  const [loading, setLoading] = useState(true)
  // A failed page is held apart from the paging state so it cannot take the control away with
  // it: the cursor is still known, so the next tap is the retry, and a reader who reloads
  // instead would lose every page already fetched.
  const [failed, setFailed] = useState(false)

  const take = (page: Awaited<ReturnType<typeof loadChannelArchivePage>>) => {
    setPosts((current) => [...current, ...page.posts])
    setNextBefore(page.nextBefore)
    setFailed(false)
  }
  // The first page arrives with the section; every later one is a tap away.
  useEffect(() => {
    const controller = new AbortController()
    loadChannelArchivePage(undefined, controller.signal)
      .then((page) => { if (!controller.signal.aborted) take(page) })
      .catch(() => { if (!controller.signal.aborted) setFailed(true) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [])
  const loadOlder = async (before: number) => {
    setLoading(true)
    try {
      take(await loadChannelArchivePage(before))
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  return (
    <section aria-labelledby="channel-archive-title" className="channel-archive">
      <h2 id="channel-archive-title">From the Long Vol channel</h2>
      <p className="channel-archive-note">
        The Telegram channel this site replaced, March to September 2026. Telegram deleted older messages after a month.
      </p>
      <ol className="channel-posts">
        {posts.map((post) => {
          // A post that is only a link is shown as that link; otherwise the links follow the text.
          const bareLink = post.links.length === 1 && post.text === post.links[0]
          return (
            <li className="channel-post" key={post.id}>
              <time dateTime={post.postedAt}>{issueDate.format(new Date(post.postedAt))}</time>
              {bareLink
                ? <a href={post.links[0]} rel="noreferrer" target="_blank">{new URL(post.links[0]!).host}<ArrowUpRight aria-hidden="true" /></a>
                : (
                    <>
                      <p>{post.text}</p>
                      {post.links.length > 0 && (
                        <span className="channel-post-links">
                          {post.links.map((link) => (
                            <a href={link} key={link} rel="noreferrer" target="_blank">{new URL(link).host}<ArrowUpRight aria-hidden="true" /></a>
                          ))}
                        </span>
                      )}
                    </>
                  )}
            </li>
          )
        })}
      </ol>
      {failed && (
        <Alert className="recommendation-archive-error" variant="destructive">
          <AlertTitle>Channel archive unavailable</AlertTitle>
          <AlertDescription>The channel archive could not be loaded.</AlertDescription>
        </Alert>
      )}
      {loading && <div className="channel-archive-loading" role="status"><Spinner />Loading posts</div>}
      {!loading && nextBefore !== undefined && (
        <Button onClick={() => void loadOlder(nextBefore)} size="sm" type="button" variant="outline">Older posts</Button>
      )}
      {!loading && nextBefore === undefined && posts.length > 0 && (
        <p className="channel-archive-end">That is the whole surviving channel.</p>
      )}
    </section>
  )
}

function RecommendationArchive({
  availableSymbols,
  latest,
  now,
  onConnect,
  onSymbol,
  signedIn,
}: {
  availableSymbols: ReadonlySet<string>
  latest?: DailyRecommendations
  now?: Date
  onConnect: () => void
  onSymbol: (symbol: string) => void
  signedIn: boolean
}) {
  const [history, setHistory] = useState<DailyRecommendations[]>(() => latest ? [latest] : [])
  const [index, setIndex] = useState(0)
  const [archiveEnd, setArchiveEnd] = useState(!latest)
  const [archiveError, setArchiveError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const current = history[index]
  // One clock for the age, the countdown, and whether the cover may point at the offer.
  const clock = useMinuteClock(now)
  const refreshOpen = researchRefreshOpen(latest?.publishedAt, clock)
  // The panel belongs to the latest brief only: an older one is history, and the offer to
  // replace the current brief would be misplaced under it.
  const onLatest = index === 0
  const runPanel = onLatest
    ? <ResearchRunPanel latest={latest} now={clock} onConnect={onConnect} signedIn={signedIn} />
    : null
  // A brief with nothing in it predates the publish boundary's refusal of one; the panel, or
  // for an older one the bare fact, is all there is to show for it.
  const showRunPanelOnly = !current || (current.recommendations.length === 0 && current.links.length === 0)

  const openOlder = async () => {
    const loaded = history[index + 1]
    if (loaded) {
      setIndex(index + 1)
      return
    }
    if (!current) return
    setArchiveError(undefined)
    setLoading(true)
    try {
      const previous = await loadPreviousDailyRecommendations(current.publishedAt)
      if (!previous) {
        setArchiveEnd(true)
        return
      }
      if (previous.publishedAt >= current.publishedAt) {
        throw new Error('Recommendation archive returned an out-of-order result')
      }
      setHistory((current) => [...current, previous])
      setIndex(index + 1)
    } catch {
      setArchiveError('Previous recommendations could not be loaded.')
    } finally {
      setLoading(false)
    }
  }
  const navigation = latest
    ? (
        <RecommendationNavigation
          index={index}
          loading={loading}
          onNewer={() => {
            setArchiveError(undefined)
            setIndex(Math.max(0, index - 1))
          }}
          onOlder={() => void openOlder()}
          olderDisabled={archiveEnd && !history[index + 1]}
        />
      )
    : null
  const archiveFailure = archiveError
    ? (
        <Alert className="recommendation-archive-error" variant="destructive">
          <AlertTitle>Archive unavailable</AlertTitle>
          <AlertDescription>{archiveError}</AlertDescription>
        </Alert>
      )
    : null

  if (showRunPanelOnly) {
    return (
      <div className="recommendation-screen">
        {navigation}
        {archiveFailure}
        {runPanel ?? <p className="recommendation-empty">This brief published nothing.</p>}
        <ChannelArchive />
      </div>
    )
  }
  return (
    <div className="recommendation-screen">
      {navigation}
      {archiveFailure}
      <header className="recommendation-cover">
        <time dateTime={current.publishedAt}>{issueDate.format(new Date(current.publishedAt))}</time>
        {/* The model is part of the brief's provenance, so it is stated on the brief itself and
            not only in the panel below. Reported by the agent that submitted it. */}
        <p className="recommendation-byline">
          {current.model ? <>Generated by <strong>{current.model}</strong></> : 'Model not recorded'}
          {/* The handle the publishing member chose for this brief, and nothing account-derived:
              a brief published without one says nothing about who published it. */}
          {current.byline && <> &middot; published by <strong>{current.byline}</strong></>}
          {onLatest && refreshOpen && (
            <>
              {' '}&middot;{' '}
              {/* The page scrolls inside the tab, not the window, and the router owns the hash,
                  so a bare fragment link changed the address and moved nothing. The href stays
                  for anyone reading the link; the scroll is done by hand. */}
              <a
                href="#research-run"
                onClick={(event) => {
                  event.preventDefault()
                  document.getElementById('research-run')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
              >
                Generate a fresh brief
              </a>
            </>
          )}
        </p>
        <h1>{current.regime}</h1>
        <p>{current.regimeDetail}</p>
        <p>{current.summary}</p>
      </header>
      <div className="recommendations-section">
        {current.links.length > 0 && (
          <section aria-labelledby="recommendation-links-title" className="recommendation-links-section">
            {/* The list is self-evidently links; naming it only repeated what a reader can
                see. The heading stays for anyone navigating by heading or landmark. */}
            <h2 className="sr-only" id="recommendation-links-title">Links</h2>
            <ol className="recommendation-links">
              {current.links.map((item) => (
                <li key={item.url}>
                  <a
                    data-preview={item.previewImageUrl ? '' : undefined}
                    href={item.url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {item.previewImageUrl && (
                      <img
                        alt=""
                        decoding="async"
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        src={item.previewImageUrl}
                      />
                    )}
                    <strong>{item.title}</strong><ArrowUpRight aria-hidden="true" />
                    <span>{item.description}</span>
                  </a>
                </li>
              ))}
            </ol>
          </section>
        )}
        <div className="recommendation-stack">
          {current.recommendations.map((recommendation) => (
            <Card className="recommendation-card" key={`${recommendation.symbol}-${recommendation.headline}`} variant="flat">
              <CardHeader className="recommendation-top">
                {availableSymbols.has(recommendation.symbol)
                  ? (
                      <Button onClick={() => onSymbol(recommendation.symbol)} size="lg" type="button" variant="link">
                        {recommendation.symbol}<ArrowUpRight data-icon="inline-end" />
                      </Button>
                    )
                  : <strong className="recommendation-symbol">{recommendation.symbol}</strong>}
                <Badge variant={recommendation.direction}>{recommendation.direction}</Badge>
                <CardTitle>{recommendation.headline}</CardTitle>
                <CardDescription>{recommendation.description}</CardDescription>
              </CardHeader>
              <CardContent className="order-line">
                <span>Recommended order</span>
                <strong>{recommendedOrderLabel(recommendation.recommendedOrder)}</strong>
              </CardContent>
              <CardFooter className="risk-line">
                <Alert>
                  <ShieldCheck aria-hidden="true" />
                  <AlertTitle>What breaks it</AlertTitle>
                  <AlertDescription>{recommendation.risk}</AlertDescription>
                </Alert>
              </CardFooter>
              {recommendation.verification && (
                <RecommendationVerificationNote verification={recommendation.verification} />
              )}
              {recommendation.sources.length > 0 && (
                <CardFooter className="recommendation-sources">
                  {recommendation.sources.map((source) => (
                    <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
                      {source.label}<ArrowUpRight aria-hidden="true" />
                    </a>
                  ))}
                </CardFooter>
              )}
            </Card>
          ))}
        </div>
        <p className="disclaimer">Not financial advice.</p>
      </div>
      {runPanel}
      <ChannelArchive />
    </div>
  )
}

export function RecommendationScreen({
  availableSymbols,
  dailyRecommendations,
  now,
  onConnect,
  onSymbol,
  signedIn,
}: {
  availableSymbols: ReadonlySet<string>
  dailyRecommendations?: DailyRecommendations
  now?: Date
  onConnect: () => void
  onSymbol: (symbol: string) => void
  signedIn: boolean
}) {
  return (
    <RecommendationArchive
      availableSymbols={availableSymbols}
      key={dailyRecommendations
        ? `${dailyRecommendations.id}:${dailyRecommendations.publishedAt}`
        : 'no-recommendations'}
      latest={dailyRecommendations}
      now={now}
      onConnect={onConnect}
      onSymbol={onSymbol}
      signedIn={signedIn}
    />
  )
}
