import { useEffect, useState } from 'react'
import { ArrowUpRight, ChevronLeft, ChevronRight, ShieldCheck } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import { Spinner } from '#/components/ui/spinner'
import { loadPreviousResearchBrief } from '../data/research-archive'
import { type ResearchBrief } from '../domain/market'
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

function NextBriefRun({ fixedNow }: { fixedNow?: Date }) {
  const [now, setNow] = useState(() => fixedNow ?? new Date())
  useEffect(() => {
    if (fixedNow) return
    const timer = window.setInterval(() => setNow(new Date()), COUNTDOWN_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [fixedNow])
  const run = nextDailyResearchRun(now)
  return (
    <section aria-live="polite" className="brief-next-run">
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

function BriefNavigation({
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
    <nav aria-label="Brief archive" className="brief-navigation">
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

function BriefArchive({
  availableSymbols,
  latest,
  now,
  onSymbol,
}: {
  availableSymbols: ReadonlySet<string>
  latest?: ResearchBrief
  now?: Date
  onSymbol: (symbol: string) => void
}) {
  const [briefs, setBriefs] = useState<ResearchBrief[]>(() => latest ? [latest] : [])
  const [index, setIndex] = useState(0)
  const [archiveEnd, setArchiveEnd] = useState(!latest)
  const [archiveError, setArchiveError] = useState<string>()
  const [loading, setLoading] = useState(false)
  const brief = briefs[index]
  const showNextRun = !brief || (brief.ideas.length === 0 && brief.readingList.length === 0)

  const openOlder = async () => {
    const loaded = briefs[index + 1]
    if (loaded) {
      setIndex(index + 1)
      return
    }
    if (!brief) return
    setArchiveError(undefined)
    setLoading(true)
    try {
      const previous = await loadPreviousResearchBrief(brief.publishedAt)
      if (!previous) {
        setArchiveEnd(true)
        return
      }
      if (previous.publishedAt >= brief.publishedAt) {
        throw new Error('Research archive returned an out-of-order brief')
      }
      setBriefs((current) => [...current, previous])
      setIndex(index + 1)
    } catch {
      setArchiveError('Previous brief could not be loaded.')
    } finally {
      setLoading(false)
    }
  }
  const navigation = latest
    ? (
        <BriefNavigation
          index={index}
          loading={loading}
          onNewer={() => {
            setArchiveError(undefined)
            setIndex(Math.max(0, index - 1))
          }}
          onOlder={() => void openOlder()}
          olderDisabled={archiveEnd && !briefs[index + 1]}
        />
      )
    : null
  const archiveFailure = archiveError
    ? (
        <Alert className="brief-archive-error" variant="destructive">
          <AlertTitle>Archive unavailable</AlertTitle>
          <AlertDescription>{archiveError}</AlertDescription>
        </Alert>
      )
    : null

  if (showNextRun) {
    return (
      <div className="brief-screen">
        {navigation}
        {archiveFailure}
        <NextBriefRun fixedNow={now} />
      </div>
    )
  }
  return (
    <div className="brief-screen">
      {navigation}
      {archiveFailure}
      <header className="brief-cover">
        <time dateTime={brief.publishedAt}>{issueDate.format(new Date(brief.publishedAt))}</time>
        <h1>{brief.regime}</h1>
        <p>{brief.regimeDetail}</p>
        <p>{brief.summary}</p>
      </header>
      <div className="ideas-section">
        {brief.readingList.length > 0 && (
          <section aria-label="Sources" className="reading-section">
            <ol className="reading-list">
              {brief.readingList.map((item) => (
                <li key={item.url}>
                  <a href={item.url} rel="noreferrer" target="_blank">
                    <strong>{item.title}</strong><ArrowUpRight aria-hidden="true" />
                    <span>{item.reason}</span>
                  </a>
                </li>
              ))}
            </ol>
          </section>
        )}
        <div className="idea-stack">
          {brief.ideas.map((idea) => (
            <Card className="idea-card" key={`${idea.symbol}-${idea.headline}`} variant="flat">
              <CardHeader className="idea-top">
                {availableSymbols.has(idea.symbol)
                  ? (
                      <Button onClick={() => onSymbol(idea.symbol)} size="lg" type="button" variant="link">
                        {idea.symbol}<ArrowUpRight data-icon="inline-end" />
                      </Button>
                    )
                  : <strong className="idea-symbol">{idea.symbol}</strong>}
                <Badge variant={idea.direction}>{idea.direction}</Badge>
                <CardTitle>{idea.headline}</CardTitle>
                <CardDescription>{idea.description}</CardDescription>
              </CardHeader>
              {idea.play && (
                <CardContent className="play-line">
                  <span>Potential play</span>
                  <strong>{idea.play}</strong>
                </CardContent>
              )}
              <CardFooter className="risk-line">
                <Alert>
                  <ShieldCheck aria-hidden="true" />
                  <AlertTitle>What breaks it</AlertTitle>
                  <AlertDescription>{idea.risk}</AlertDescription>
                </Alert>
              </CardFooter>
              {idea.sources.length > 0 && (
                <CardFooter className="idea-sources">
                  {idea.sources.map((source) => (
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

export function BriefScreen({
  availableSymbols,
  brief,
  now,
  onSymbol,
}: {
  availableSymbols: ReadonlySet<string>
  brief?: ResearchBrief
  now?: Date
  onSymbol: (symbol: string) => void
}) {
  return (
    <BriefArchive
      availableSymbols={availableSymbols}
      key={brief ? `${brief.id}:${brief.publishedAt}` : 'no-brief'}
      latest={brief}
      now={now}
      onSymbol={onSymbol}
    />
  )
}
