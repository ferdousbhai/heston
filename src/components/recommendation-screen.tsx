import { useEffect, useState } from 'react'
import { ArrowUpRight, ChevronLeft, ChevronRight, ShieldCheck } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import { Spinner } from '#/components/ui/spinner'
import { loadPreviousDailyRecommendations } from '../data/recommendation-archive'
import { type DailyRecommendations } from '../domain/market'
import { recommendedOrderLabel } from '../domain/recommended-order'
import { DAILY_RESEARCH_SCHEDULE, nextDailyResearchRun } from '../domain/research-schedule'

const issueDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const nextRunDate = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: DAILY_RESEARCH_SCHEDULE.timeZone,
  weekday: 'long',
})
const nextRunTime = new Intl.DateTimeFormat('en-US', {
  hour: 'numeric',
  minute: '2-digit',
  timeZone: DAILY_RESEARCH_SCHEDULE.timeZone,
  timeZoneName: 'short',
})
const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const COUNTDOWN_REFRESH_MS = MINUTE_MS

export function researchRunCountdown(now: Date, run: Date): string {
  const remaining = run.getTime() - now.getTime()
  if (remaining <= 0) return 'Starting shortly'
  if (remaining < HOUR_MS) {
    const minutes = Math.ceil(remaining / MINUTE_MS)
    return `In about ${minutes} minute${minutes === 1 ? '' : 's'}`
  }
  if (remaining < DAY_MS) {
    const hours = Math.ceil(remaining / HOUR_MS)
    return `In about ${hours} hour${hours === 1 ? '' : 's'}`
  }
  const days = Math.round(remaining / DAY_MS)
  return `In about ${days} day${days === 1 ? '' : 's'}`
}

function NextRecommendationRun({ fixedNow }: { fixedNow?: Date }) {
  const [now, setNow] = useState(() => fixedNow ?? new Date())
  useEffect(() => {
    if (fixedNow) return
    const timer = window.setInterval(() => setNow(new Date()), COUNTDOWN_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [fixedNow])
  const run = nextDailyResearchRun(now)
  return (
    <section aria-live="polite" className="recommendation-next-run">
      <Empty>
        <EmptyHeader>
          <h1>Next research run</h1>
          <EmptyDescription>
            <time dateTime={run.toISOString()}>{`${nextRunDate.format(run)} at ${nextRunTime.format(run)}`}</time>
            <span>{researchRunCountdown(now, run)}</span>
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </section>
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
  const showNextRun = !current || (current.recommendations.length === 0 && current.links.length === 0)

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

  if (showNextRun) {
    return (
      <div className="recommendation-screen">
        {navigation}
        {archiveFailure}
        <NextRecommendationRun fixedNow={now} />
      </div>
    )
  }
  return (
    <div className="recommendation-screen">
      {navigation}
      {archiveFailure}
      <header className="recommendation-cover">
        <time dateTime={current.publishedAt}>{issueDate.format(new Date(current.publishedAt))}</time>
        <h1>{current.regime}</h1>
        <p>{current.regimeDetail}</p>
        <p>{current.summary}</p>
      </header>
      <div className="recommendations-section">
        {current.links.length > 0 && (
          <section aria-labelledby="recommendation-links-title" className="recommendation-links-section">
            <h2 id="recommendation-links-title">Links</h2>
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
