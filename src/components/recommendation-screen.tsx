import { useEffect, useState } from 'react'
import { ArrowUpRight, ChevronLeft, ChevronRight, ShieldAlert, ShieldCheck } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#/components/ui/card'
import { Spinner } from '#/components/ui/spinner'
import { loadChannelArchivePage } from '../data/channel-archive'
import { loadPreviousDailyRecommendations } from '../data/recommendation-archive'
import { type ChannelPost } from '../domain/channel-post'
import { researchGeneratorLabel, type DailyRecommendations, type RecommendationVerification } from '../domain/market'
import { recommendedOrderLabel } from '../domain/recommended-order'

// The run publishes at a time of day, not on a day, so the issue line carries the time too.
const issueDate = new Intl.DateTimeFormat('en-US', {
  day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short', timeZone: 'America/New_York', timeZoneName: 'short', year: 'numeric',
})
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
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

/**
 * A clock that ticks on the minute unless a test pins it. The age is stated to the minute, so
 * that is how often it can move.
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
 * What the current brief is -- which model, how long ago. Nothing on this site produces the next
 * one: generation lives in a separate private Workflow, so the note describes provenance and
 * offers nothing.
 */
function StandingBriefNote({ latest, now }: { latest?: DailyRecommendations; now: Date }) {
  return (
    <section aria-labelledby="standing-brief-title" className="research-run-panel" id="standing-brief">
      <h2 id="standing-brief-title">{latest ? 'About this brief' : 'No brief yet'}</h2>
      <p className="research-run-standing">
        {latest
          ? (
              <>
                This brief was generated {briefAge(now, latest.publishedAt)}
                {latest.model ? <> by <strong>{researchGeneratorLabel(latest.model)}</strong></> : '; the model was not recorded'}.
              </>
            )
          : 'Nothing has been published yet.'}
      </p>
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
  onSymbol,
}: {
  availableSymbols: ReadonlySet<string>
  latest?: DailyRecommendations
  now?: Date
  onSymbol: (symbol: string) => void
}) {
  const [history, setHistory] = useState<DailyRecommendations[]>(() => latest ? [latest] : [])
  const [index, setIndex] = useState(0)
  const [archiveEnd, setArchiveEnd] = useState(!latest)
  const [archiveError, setArchiveError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const current = history[index]
  const clock = useMinuteClock(now)
  // The note belongs to the latest brief only: an older one is history.
  const onLatest = index === 0
  const runPanel = onLatest ? <StandingBriefNote latest={latest} now={clock} /> : null
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
          {current.model ? <>Generated by <strong>{researchGeneratorLabel(current.model)}</strong></> : 'Model not recorded'}
          {/* The handle the publishing member chose for this brief, and nothing account-derived:
              a brief published without one says nothing about who published it. */}
          {current.byline && <> &middot; published by <strong>{current.byline}</strong></>}
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
  onSymbol,
}: {
  availableSymbols: ReadonlySet<string>
  dailyRecommendations?: DailyRecommendations
  now?: Date
  onSymbol: (symbol: string) => void
}) {
  return (
    <RecommendationArchive
      availableSymbols={availableSymbols}
      key={dailyRecommendations
        ? `${dailyRecommendations.id}:${dailyRecommendations.publishedAt}`
        : 'no-recommendations'}
      latest={dailyRecommendations}
      now={now}
      onSymbol={onSymbol}
    />
  )
}
