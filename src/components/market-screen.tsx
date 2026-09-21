import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronRight, Search, Star, X } from 'lucide-react'
import { matchSorter } from 'match-sorter'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader } from '#/components/ui/card'
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from '#/components/ui/drawer'
import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import { Progress } from '#/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import { equitySymbolFromModelText } from '../domain/instrument'
import { cn } from '#/lib/utils'
import { latestSessionCandles, REGULAR_SESSION_MS, type CandlePoint } from '../domain/candle'
import { recommendedOrderLabel } from '../domain/recommended-order'
import {
  CATALYST_KIND_NAMES,
  hasNearTermCatalyst,
  catalystCountdown,
  catalystKindName,
  catalystLabel,
  catalystSourceLink,
  catalystTimingLabel,
  marketDate,
  nextCatalystsBySymbol,
  upcomingCatalystsForSymbol,
  type Catalyst,
} from '../domain/catalyst'
import {
  fiftyTwoWeekPosition,
  formatMarketMetric,
  formatMarketPrice,
  issuerName,
  tickerFromPublic,
  termStructureSpread,
  volatilityVerdict,
  type IvTermStructure,
  type DailyRecommendations,
  type Ticker,
  type PublicSymbolLookup,
  type VolatilityVerdict,
  type Watchlist,
} from '../domain/market'
import { evidenceSourceHost, type SymbolEvidence } from '../domain/symbol-evidence'
import { useCatalystSearch } from '../data/catalyst-refresh'
import { usePublicCatalysts } from '../data/public-catalysts'
import { loadSymbolEvidence } from '../data/symbol-evidence'
import { useYearCandles } from '../data/year-candles'
import { useSymbolSearch, type SymbolSearchState } from '../data/symbol-search'
import { CatalystStories } from './catalyst-stories'
import { compactElapsedLabel, useElapsedLabel } from './top-bar'

const verdictCopy = {
  cheap: 'Cheap',
  fair: 'Fair',
  rich: 'Expensive',
  unavailable: 'Unavailable',
} satisfies Record<VolatilityVerdict, string>

function premiumScore(ticker: Pick<Ticker, 'ivRank' | 'ivPercentile'>): number | undefined {
  if (ticker.ivRank === undefined || ticker.ivPercentile === undefined) return undefined
  return Math.round((ticker.ivRank + ticker.ivPercentile) / 2)
}

const compactFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  notation: 'compact',
})

const catalystDateFormatter = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
  year: 'numeric',
})

function compactMetric(value: number | undefined, prefix = '', suffix = ''): string {
  return value === undefined ? '—' : `${prefix}${compactFormatter.format(value)}${suffix}`
}

function formatSignedMetric(value: number | undefined, suffix = ''): string {
  if (value === undefined) return '—'
  return `${value > 0 ? '+' : ''}${formatMarketMetric(value)}${suffix}`
}

function assetLabel(ticker: Pick<Ticker, 'assetType'>): string | undefined {
  return ticker.assetType === 'etf' ? 'ETF' : ticker.assetType === 'index' ? 'Index' : undefined
}

type SortDirection = 'asc' | 'desc'
type SortKey = 'symbol' | 'marketCap' | 'price' | 'year' | 'volume' | 'premium' | 'liquidity'

/** The breakpoint the year column appears at, so nothing loads history a screen cannot show. */
const WIDE_VIEWPORT = '(min-width: 1120px)'
/**
 * Below this the table gives way to a list. Eight columns need 850px, and a phone showed the
 * first three of them with the price off the right edge; a list keeps every row one screen
 * wide. It is the same bound the focus card stacks at, so both surfaces change shape together.
 */
const NARROW_VIEWPORT = '(max-width: 959px)'

function useMediaQuery(query: string): boolean {
  // Both callbacks are stable per query: React keys the subscription on the subscribe
  // identity, so a closure rebuilt on every render re-added the change listener on every
  // commit, and this screen commits on every live quote. The query list itself is still
  // resolved inside them, so a renderer without matchMedia — jsdom, or a server pass, which
  // reads the server snapshot instead — never touches `window` at all.
  const subscribe = useCallback((onChange: () => void) => {
    const list = window.matchMedia?.(query)
    list?.addEventListener('change', onChange)
    return () => list?.removeEventListener('change', onChange)
  }, [query])
  const getSnapshot = useCallback(() => window.matchMedia?.(query).matches ?? false, [query])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

/**
 * What the pill beside a listed price shows. One tap cycles every row together, the way a phone
 * stocks app does, so a reader compares the list on any of these without it growing a column.
 * Day change leads because it is what a glance at a list is for; the rest are the table's own
 * columns in the order the table sorts them.
 */
type ListMetric = 'change' | 'premium' | 'volume' | 'marketCap'
const LIST_METRICS: readonly ListMetric[] = ['change', 'premium', 'volume', 'marketCap']
const LIST_METRIC_LABELS = {
  change: 'Day change',
  marketCap: 'Market cap',
  premium: 'Option premium',
  volume: 'Volume',
} satisfies Record<ListMetric, string>

type ListPill = { tone: 'down' | 'flat' | 'up' | VolatilityVerdict; value: string }

/**
 * How old a row's volatility readings are, read at render. Rows re-render with every snapshot
 * and live tick, which is at least as often as an hour-granular age can change meaningfully.
 */
function metricsAgeLabel(ticker: Pick<Ticker, 'metricsUpdatedAt'>): string | undefined {
  return ticker.metricsUpdatedAt === undefined ? undefined : compactElapsedLabel(ticker.metricsUpdatedAt, Date.now())
}

function listPill(ticker: Ticker, metric: ListMetric): ListPill {
  switch (metric) {
    case 'change':
      return {
        tone: ticker.changePercent > 0 ? 'up' : ticker.changePercent < 0 ? 'down' : 'flat',
        value: formatSignedMetric(ticker.changePercent, '%'),
      }
    case 'premium': {
      // The verdict keeps the rank that produced it beside it, as the table's premium cell does,
      // and the age of both: the provider computes them on its own schedule.
      const verdict = volatilityVerdict(ticker)
      const rank = formatIfReported(ticker.ivRank, formatMarketMetric)
      const age = metricsAgeLabel(ticker)
      return {
        tone: verdict,
        value: [verdictCopy[verdict] + (rank === undefined ? '' : ` ${rank}`), age].filter(Boolean).join(' · '),
      }
    }
    case 'volume':
      return { tone: 'flat', value: compactMetric(ticker.volume) }
    case 'marketCap':
      return { tone: 'flat', value: compactMetric(ticker.marketCap, '$') }
  }
}

const SORT_COLUMNS: { defaultDirection: SortDirection; key: SortKey; label: string }[] = [
  { defaultDirection: 'asc', key: 'symbol', label: 'Instrument' },
  { defaultDirection: 'desc', key: 'marketCap', label: 'Market cap' },
  { defaultDirection: 'desc', key: 'price', label: 'Price' },
  { defaultDirection: 'desc', key: 'year', label: '1Y' },
  { defaultDirection: 'desc', key: 'volume', label: 'Volume' },
  { defaultDirection: 'desc', key: 'premium', label: 'Option premium' },
  { defaultDirection: 'desc', key: 'liquidity', label: 'Liquidity' },
]

/**
 * Percent move across the cached year. The anchor rides the snapshot and the current price is
 * live, so sorting and the label work without the series the chart draws from.
 */
function yearReturn(ticker: Pick<Ticker, 'price' | 'yearAgoClose'>): number | undefined {
  const first = ticker.yearAgoClose
  if (first === undefined || first <= 0) return undefined
  return ((ticker.price - first) / first) * 100
}

/**
 * A year of daily closes reads on its own elapsed span rather than a fixed one: the series is
 * whatever the cache holds, so stretching it to the full width is honest here in a way it is
 * not for a session that has barely started.
 */
function YearSparkline({ closes }: { closes: readonly number[] }) {
  const low = Math.min(...closes)
  const span = Math.max(...closes) - low || 1
  const step = closes.length > 1 ? 100 / (closes.length - 1) : 0
  const line = closes
    .map((close, index) => `${(index * step).toFixed(2)},${(23 - ((close - low) / span) * 21).toFixed(2)}`)
    .join(' ')
  return (
    <svg aria-hidden="true" className="sparkline year-sparkline" preserveAspectRatio="none" viewBox="0 0 100 26">
      <polyline points={line} />
    </svg>
  )
}

/**
 * Draws one session, which the caller narrows: the stored series deliberately keeps the prior
 * session, so a guard on the stored length would pass on yesterday's bars while this session
 * holds one point, and the polyline would be a single vertex — an empty chart in a filled slot.
 */
function Sparkline({ session }: { session: readonly CandlePoint[] }) {
  const closes = session.map((point) => point.close)
  const low = Math.min(...closes)
  const span = Math.max(...closes) - low || 1
  // The axis is the whole session rather than the data it has so far, so a partial morning
  // draws a short line at the left instead of stretching a few bars across the full width.
  const openedAt = session[0]!.time
  const line = session
    .map((point) => {
      const x = Math.min(100, ((point.time - openedAt) / REGULAR_SESSION_MS) * 100)
      return `${x.toFixed(2)},${(23 - ((point.close - low) / span) * 21).toFixed(2)}`
    })
    .join(' ')
  return (
    <svg aria-hidden="true" className="sparkline session-sparkline" preserveAspectRatio="none" viewBox="0 0 100 26">
      <polyline points={line} />
    </svg>
  )
}

const SORT_METRICS = {
  marketCap: (ticker) => ticker.marketCap,
  price: (ticker) => ticker.price,
  year: yearReturn,
  volume: (ticker) => ticker.volume,
  premium: premiumScore,
  liquidity: (ticker) => ticker.liquidity,
} satisfies Record<Exclude<SortKey, 'symbol'>, (ticker: Ticker) => number | undefined>

function compareBySort(left: Ticker, right: Ticker, sort: { direction: SortDirection; key: SortKey }): number {
  if (sort.key === 'symbol') {
    const delta = left.symbol.localeCompare(right.symbol)
    return sort.direction === 'asc' ? delta : -delta
  }
  const leftValue = SORT_METRICS[sort.key](left)
  const rightValue = SORT_METRICS[sort.key](right)
  if (leftValue === undefined || rightValue === undefined) {
    return Number(leftValue === undefined) - Number(rightValue === undefined)
  }
  const delta = leftValue - rightValue
  return sort.direction === 'asc' ? delta : -delta
}

function termStructureLabel(term: IvTermStructure): string {
  const spread = termStructureSpread(term)
  if (Math.abs(spread) < 1) return 'Flat'
  return spread > 0
    ? `Front +${formatMarketMetric(spread)} pts`
    : `Back +${formatMarketMetric(Math.abs(spread))} pts`
}

function yearRangeLabel(ticker: Pick<Ticker, 'price' | 'yearHigh' | 'yearLow'>): string | undefined {
  const position = fiftyTwoWeekPosition(ticker)
  if (position === undefined || ticker.yearLow === undefined || ticker.yearHigh === undefined) return undefined
  return `${formatMarketPrice(ticker.yearLow)}–${formatMarketPrice(ticker.yearHigh)} · ${Math.round(position)}%`
}

function formatIfReported<T>(reading: T | undefined, format: (reading: T) => string): string | undefined {
  return reading === undefined ? undefined : format(reading)
}

function focusTape(ticker: Ticker): Array<[label: string, value: string]> {
  const reported: Array<[label: string, value: string | undefined]> = [
    ['IV', formatIfReported(ticker.ivIndex, (iv) => `${formatMarketMetric(iv)}%`)],
    ['HV30', formatIfReported(ticker.historicalVolatility30Day, (hv) => `${formatMarketMetric(hv)}%`)],
    ['IV−HV', formatIfReported(ticker.ivHistoricalVolatility30DayDifference, (gap) => formatSignedMetric(gap, ' pts'))],
    ['5d', formatIfReported(ticker.ivIndex5DayChange, (change) => formatSignedMetric(change, ' pts'))],
    ['Rank', formatIfReported(ticker.ivRank, formatMarketMetric)],
    ['Pct', formatIfReported(ticker.ivPercentile, formatMarketMetric)],
    ['Term', formatIfReported(ticker.ivTermStructure, termStructureLabel)],
    ['Liq', formatIfReported(ticker.liquidity, (liquidity) => `${formatMarketMetric(liquidity)}/5`)],
    ['Lend', ticker.lendability],
    ['Vol', formatIfReported(ticker.volume, (volume) => compactMetric(volume))],
    ['Cap', formatIfReported(ticker.marketCap, (cap) => compactMetric(cap, '$'))],
    ['52w', yearRangeLabel(ticker)],
  ]
  const tape: Array<[label: string, value: string]> = []
  for (const [label, value] of reported) {
    if (value !== undefined) tape.push([label, value])
  }
  return tape
}

/** What an empty table says depends on how far the search got, not just that it found nothing. */
function searchEmptyMessage(query: string, status: SymbolSearchState['status']): string {
  if (!query) return 'No option metrics are available for this list.'
  if (status === 'searching') return `Searching every listed symbol for "${query}"\u2026`
  if (status === 'failed') return 'Symbol search is unavailable. Showing the loaded list only.'
  return 'No listed symbol matches your search.'
}

const CATALYST_SCOPE = `${CATALYST_KIND_NAMES.slice(0, -1).join(', ')} and ${CATALYST_KIND_NAMES.at(-1)}`

function RecommendationPanel({ recommendation }: { recommendation: DailyRecommendations['recommendations'][number] }) {
  return (
    <section className="focus-recommendation" aria-labelledby="focus-recommendation-title">
      <header className="focus-eyebrow">
        <h3 id="focus-recommendation-title">Recommendation</h3>
        <Badge variant={recommendation.direction}>{recommendation.direction}</Badge>
      </header>
      <p className="recommendation-headline">{recommendation.headline}</p>
      <p className="recommendation-body">{recommendation.description}</p>
      <p className="recommendation-risk"><span>What breaks it</span>{recommendation.risk}</p>
      <p className="recommendation-order">
        <span>Recommended order</span>
        <strong>{recommendedOrderLabel(recommendation.recommendedOrder)}</strong>
      </p>
      {recommendation.sources.length > 0 && (
        <p className="recommendation-sources">
          {recommendation.sources.map((source) => (
            <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
              {source.label}<ArrowUpRight aria-hidden="true" />
            </a>
          ))}
        </p>
      )}
    </section>
  )
}

/** An empty calendar is either one nobody has searched yet or one with nothing on it. */
function RunwayEmpty({ searching, symbol }: { searching: boolean; symbol: string }) {
  const [heading, detail] = searching
    ? [
        'Looking for what’s coming.',
        ` Nothing is on ${symbol}'s calendar yet, so Heston is searching for scheduled ${CATALYST_SCOPE} dates.`,
      ]
    : [
        'Nothing is on the calendar.',
        ` Heston tracks ${CATALYST_SCOPE} dates for ${symbol}, and none are scheduled. A re-rating from here would have to come from something unannounced.`,
      ]
  return (
    <div className="runway-empty" aria-live="polite">
      <p><strong>{heading}</strong><span className="runway-empty-detail">{detail}</span></p>
    </div>
  )
}

function CatalystRunway({
  catalysts,
  now,
  onRefresh,
  searching,
  symbol,
}: {
  catalysts: readonly Catalyst[]
  now: Date
  onRefresh?: () => void
  searching: boolean
  symbol: string
}) {
  const upcoming = upcomingCatalystsForSymbol(symbol, catalysts, now)
  // A calendar with something on it months out is still uncovered for the weeks a reader is
  // actually trading, and that is the case a search is bought for. Reporting the search only
  // inside the empty state left it running invisibly on exactly those symbols.
  const thin = !hasNearTermCatalyst(symbol, catalysts, now)

  return (
    <section className="focus-runway" aria-label="What&rsquo;s coming">
      {upcoming.length
        ? (
            <ol className="runway">
              {upcoming.map((catalyst, index) => {
                const source = catalystSourceLink(catalyst)
                return (
                  <li className={cn('runway-event', catalyst.confidence, index === 0 && 'next')} key={catalyst.id}>
                    <div className="runway-when">
                      <strong>{catalystCountdown(catalyst, now)}</strong>
                      <time dateTime={catalyst.date}>
                        {catalystDateFormatter.format(new Date(`${catalyst.date}T00:00:00Z`))}
                      </time>
                    </div>
                    <span aria-hidden="true" className="runway-mark" />
                    <div className="runway-body">
                      {/* The date the source last stated this, so an estimate that has not been
                          revisited in months reads as exactly that. */}
                      <p className="runway-kind">
                        {[catalystKindName(catalyst.kind), catalystTimingLabel(catalyst.timing), catalyst.confidence]
                          .filter(Boolean)
                          .join(' · ')}
                        {' · '}
                        <span className="runway-as-of">
                          as of <time dateTime={catalyst.updatedAt}>{catalystDateFormatter.format(new Date(catalyst.updatedAt))}</time>
                        </span>
                      </p>
                      <strong>{catalyst.title}</strong>
                      {catalyst.description && <p className="runway-detail">{catalyst.description}</p>}
                      {source && (
                        <a href={source.url} rel="noreferrer" target="_blank">
                          {source.host}<ArrowUpRight aria-hidden="true" />
                        </a>
                      )}
                    </div>
                  </li>
                )
              })}
            </ol>
          )
        : <RunwayEmpty searching={searching} symbol={symbol} />}
      {searching && upcoming.length > 0 && (
        <p className="runway-searching" aria-live="polite">
          <span aria-hidden="true" /> Searching for nearer {CATALYST_SCOPE} dates…
        </p>
      )}
      {/* A search runs at most once a month for any symbol, so coverage can read thin long
          after the web has something to say. Spending another costs money per call, which is
          why only the owner may. What it finds is stored, so every reader gets it. */}
      {onRefresh && thin && !searching && (
        <Button className="runway-refresh" onClick={onRefresh} size="sm" type="button" variant="outline">
          Search again
        </Button>
      )}
    </section>
  )
}

/**
 * What members' agents have quoted under this name since the last brief.
 *
 * Every card is a passage the server re-read on the page it cites, so the quote is the source's
 * own words; the note beside it is the recorder's reading and is labelled as theirs. Nothing
 * renders when nothing has been recorded: an empty state here would explain a surface a reader
 * has no way to fill, and the runway above it already says what is known about the name.
 */
function EvidenceCards({ symbol }: { symbol: string }) {
  // The answer carries the symbol it answers, so the cards of the name a reader just left can
  // never stand under the one they moved to while its own request is still in flight.
  const [answer, setAnswer] = useState<{ cards: readonly SymbolEvidence[]; symbol: string }>()

  useEffect(() => {
    const controller = new AbortController()
    loadSymbolEvidence(symbol, controller.signal)
      .then((cards) => { if (!controller.signal.aborted) setAnswer({ cards, symbol }) })
      // A list that cannot be fetched reads as a name nothing has been recorded under. The
      // reader is looking at a symbol, not at the state of our store, which keeps its own record.
      .catch(() => { if (!controller.signal.aborted) setAnswer({ cards: [], symbol }) })
    return () => controller.abort()
  }, [symbol])

  const cards = answer?.symbol === symbol ? answer.cards : []
  if (!cards.length) return null
  return (
    <section className="focus-evidence" aria-labelledby="focus-evidence-title">
      <header className="focus-eyebrow">
        <h3 id="focus-evidence-title">Evidence</h3>
      </header>
      <ol className="evidence-cards">
        {cards.map((card) => (
          <li className="evidence-card" key={card.id}>
            <blockquote>{card.quote}</blockquote>
            {card.note && <p className="evidence-note">{card.note}</p>}
            <p className="evidence-meta">
              {card.byline && <span>{card.byline}</span>}
              <a href={card.sourceUrl} rel="noreferrer" target="_blank">
                {evidenceSourceHost(card)}<ArrowUpRight aria-hidden="true" />
              </a>
              <time dateTime={card.recordedAt}>{catalystDateFormatter.format(new Date(card.recordedAt))}</time>
            </p>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** The pin affordance, shared by the table row, the phone row and the focus sheet. */
function PinButton({
  className,
  onToggle,
  pinned,
  symbol,
}: {
  className?: string
  onToggle: (symbol: string) => void
  pinned: boolean
  symbol: string
}) {
  return (
    <Button
      aria-label={`${pinned ? 'Unpin' : 'Pin'} ${symbol}`}
      aria-pressed={pinned}
      className={cn('pin-button', pinned && 'pinned', className)}
      onClick={() => onToggle(symbol)}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      <Star aria-hidden="true" fill={pinned ? 'currentColor' : 'none'} />
    </Button>
  )
}

/**
 * The row's own control: symbol, asset type, issuer and next catalyst, with the reading a
 * screen reader hears in place of the columns it cannot see. One definition, so the table row
 * and the phone row can never announce a name differently.
 */
function InstrumentButton({
  catalyst,
  isSelected,
  now,
  onSelect,
  ticker,
}: {
  catalyst: Catalyst | undefined
  isSelected: boolean
  now: Date
  onSelect: (symbol: string) => void
  ticker: Ticker
}) {
  const copy = verdictCopy[volatilityVerdict(ticker)]
  const type = assetLabel(ticker)
  const ivRank = ticker.ivRank === undefined ? '—' : formatMarketMetric(ticker.ivRank)

  return (
    <Button
      aria-label={`${ticker.symbol}, ${issuerName(ticker.name)}, ${copy} option premium, IV rank ${ivRank}`}
      aria-pressed={isSelected}
      className="ticker-table-button"
      onClick={() => onSelect(ticker.symbol)}
      type="button"
      variant="ghost"
    >
      <span>
        <strong>{ticker.symbol}</strong>
        {type ? <small>{type}</small> : null}
      </span>
      <small>{issuerName(ticker.name)}</small>
      {catalyst ? <small>{catalystLabel(catalyst, now)}</small> : null}
    </Button>
  )
}

// A live quote replaces one ticker object at a time, so memoizing on the default shallow
// prop compare keeps every other row off the render path. The screen passes only
// referentially stable props, `now` included.
const MarketTickerRow = memo(function MarketTickerRow({
  catalyst,
  isPinned,
  isSelected,
  now,
  onSelectTicker,
  onTogglePinned,
  ticker,
  yearCloses,
}: {
  catalyst: Catalyst | undefined
  isPinned: boolean
  isSelected: boolean
  now: Date
  onSelectTicker: (symbol: string) => void
  onTogglePinned: (symbol: string) => void
  ticker: Ticker
  yearCloses?: readonly number[]
}) {
  const verdict = volatilityVerdict(ticker)
  const copy = verdictCopy[verdict]
  const rangePosition = fiftyTwoWeekPosition(ticker)
  const session = latestSessionCandles(ticker.sparkline)

  return (
    <TableRow data-state={isSelected ? 'selected' : undefined}>
      <TableCell className="pin-cell">
        <PinButton onToggle={onTogglePinned} pinned={isPinned} symbol={ticker.symbol} />
      </TableCell>
      <TableCell className="instrument-cell">
        <InstrumentButton
          catalyst={catalyst}
          isSelected={isSelected}
          now={now}
          onSelect={onSelectTicker}
          ticker={ticker}
        />
      </TableCell>
      <TableCell className="market-cap-cell">
        <strong>{compactMetric(ticker.marketCap, '$')}</strong>
      </TableCell>
      <TableCell className="price-cell">
        <div className="price-session">
          {/* Snapshot quotes carry two synthetic endpoints; only render a chart for a richer live candle series. */}
          {session.length > 2 ? <Sparkline session={session} /> : null}
          <span>
            <strong>{formatMarketPrice(ticker.price)}</strong>
            <small>{formatSignedMetric(ticker.changePercent, '%')}</small>
          </span>
        </div>
        {/* An unreported reading is left out rather than announced, as the focus tape does;
            the cell's own metric still shows an em dash so the row is never silently short. */}
        {rangePosition === undefined
          ? null
          : <Progress className="price-range" aria-label={`${Math.round(rangePosition)}% of 52-week range`} value={rangePosition} />}
      </TableCell>
      {/* The series is fetched on its own, only where the column is drawn, so it is absent
          until that request answers. The move beside it needs only the snapshot's anchor. */}
      <TableCell className="year-cell">
        {yearCloses && yearCloses.length > 1 ? <YearSparkline closes={yearCloses} /> : null}
        <strong>{formatSignedMetric(yearReturn(ticker), '%')}</strong>
      </TableCell>
      {/* tastytrade reports equity day share volume here, not 24-hour or option-contract
          volume. */}
      <TableCell className="volume-cell">
        <strong>{compactMetric(ticker.volume)}</strong>
      </TableCell>
      {/* IV rank rides along as the premium cell's third line rather than a column of its own,
          so the verdict keeps the reading that produced it next to it. */}
      <TableCell className={`premium-cell ${verdict}`}>
        <strong>{copy}</strong>
        <small>{formatIfReported(ticker.ivIndex, (iv) => `${formatMarketMetric(iv)}% IV`) ?? '—'}</small>
        <small>
          {[formatIfReported(ticker.ivRank, (rank) => `${formatMarketMetric(rank)} rank`) ?? '—', metricsAgeLabel(ticker)]
            .filter(Boolean)
            .join(' · ')}
        </small>
      </TableCell>
      <TableCell className="liquidity-cell">
        <strong>{formatIfReported(ticker.liquidity, (liquidity) => `${formatMarketMetric(liquidity)}/5`) ?? '—'}</strong>
        {ticker.lendability ? <small>{ticker.lendability}</small> : null}
      </TableCell>
    </TableRow>
  )
})

/**
 * The phone row: what the table says, one screen wide. Symbol, issuer and next catalyst on the
 * left, the session chart when the feed carries one, and the price with one switchable reading
 * under it on the right. Memoized on the same terms as the table row.
 */
const MarketListRow = memo(function MarketListRow({
  catalyst,
  isPinned,
  isSelected,
  metric,
  now,
  onCycleMetric,
  onSelectTicker,
  onTogglePinned,
  ticker,
  yearCloses,
}: {
  catalyst: Catalyst | undefined
  isPinned: boolean
  isSelected: boolean
  metric: ListMetric
  now: Date
  onCycleMetric: () => void
  onSelectTicker: (symbol: string) => void
  onTogglePinned: (symbol: string) => void
  ticker: Ticker
  yearCloses?: readonly number[]
}) {
  const verdict = volatilityVerdict(ticker)
  const pill = listPill(ticker, metric)
  const nextMetric = LIST_METRICS[(LIST_METRICS.indexOf(metric) + 1) % LIST_METRICS.length]!
  const session = latestSessionCandles(ticker.sparkline)

  return (
    <li className={cn('watch-row', verdict)} data-state={isSelected ? 'selected' : undefined}>
      <PinButton onToggle={onTogglePinned} pinned={isPinned} symbol={ticker.symbol} />
      <InstrumentButton
        catalyst={catalyst}
        isSelected={isSelected}
        now={now}
        onSelect={onSelectTicker}
        ticker={ticker}
      />
      {/* The session chart when the feed carries one; otherwise the year, which every reader
          has. A row with neither draws nothing rather than a synthetic two-point line. */}
      {session.length > 2
        ? <Sparkline session={session} />
        : yearCloses && yearCloses.length > 1 ? <YearSparkline closes={yearCloses} /> : null}
      <div className="watch-row-quote">
        <strong>{formatMarketPrice(ticker.price)}</strong>
        <button
          aria-label={`${LIST_METRIC_LABELS[metric]} ${pill.value}. Show ${LIST_METRIC_LABELS[nextMetric].toLowerCase()}`}
          className="watch-pill"
          data-tone={pill.tone}
          onClick={onCycleMetric}
          type="button"
        >
          {pill.value}
        </button>
      </div>
    </li>
  )
})

/** The table's sortable headers, as one control a phone has room for. */
function SortControl({
  relevance,
  onChange,
  sort,
}: {
  relevance: boolean
  onChange: (sort: { direction: SortDirection; key: SortKey }) => void
  sort: { direction: SortDirection; key: SortKey }
}) {
  const flipped = sort.direction === 'asc' ? 'desc' : 'asc'
  return (
    <div className="watch-sort">
      <select
        aria-label="Sort by"
        onChange={(event) => {
          const column = SORT_COLUMNS.find((candidate) => candidate.key === event.target.value)
          if (column) onChange({ direction: column.defaultDirection, key: column.key })
        }}
        value={relevance ? 'relevance' : sort.key}
      >
        {relevance && <option value="relevance">Relevance</option>}
        {SORT_COLUMNS.map((column) => <option key={column.key} value={column.key}>{column.label}</option>)}
      </select>
      <button
        disabled={relevance}
        aria-label={`Sort ${flipped === 'asc' ? 'ascending' : 'descending'}`}
        className="sort-button"
        onClick={() => onChange({ direction: flipped, key: sort.key })}
        type="button"
      >
        {sort.direction === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
      </button>
    </div>
  )
}

export function MarketScreen({
  activeWatchlist,
  catalysts,
  owner,
  onSelectTicker,
  onTogglePinned,
  pinnedSymbols,
  dailyRecommendations,
  selected,
  tickers,
}: {
  activeWatchlist: Watchlist
  catalysts: Catalyst[]
  owner: boolean
  onSelectTicker: (symbol: string, lookup?: PublicSymbolLookup) => void
  onTogglePinned: (symbol: string, lookup?: PublicSymbolLookup) => void
  pinnedSymbols: readonly string[]
  dailyRecommendations?: DailyRecommendations
  selected: Ticker
  tickers: Ticker[]
}) {
  const marketDay = marketDate()
  // Every catalyst label here is day-granular, so the screen's clock advances only with the
  // New York market date: a `now` rebuilt on each render would re-render every memoized row
  // for labels that cannot have changed. Midday UTC falls on the same New York day, so this
  // anchor reads back as `marketDay`.
  const now = useMemo(() => new Date(`${marketDay}T12:00:00Z`), [marketDay])
  const [sort, setSort] = useState<{ direction: SortDirection; key: SortKey }>({ direction: 'desc', key: 'volume' })
  const [query, setQuery] = useState('')
  const [searchSort, setSearchSort] = useState(false)
  const [listMetric, setListMetric] = useState<ListMetric>('change')
  // On a phone the focus card lives in a sheet over the list, so the list is the screen.
  const [detailOpen, setDetailOpen] = useState(false)
  const narrow = useMediaQuery(NARROW_VIEWPORT)
  const pinned = new Set(pinnedSymbols)
  const trimmedQuery = equitySymbolFromModelText(query) ?? query.trim()
  const matched = trimmedQuery
    ? matchSorter(tickers, trimmedQuery, { keys: ['symbol', 'name'] })
    : activeWatchlist.symbols.flatMap((symbol) => {
        const ticker = tickers.find((candidate) => candidate.symbol === symbol)
        return ticker ? [ticker] : []
      })
  // A fuzzy local match is not proof that the catalog lacks the exact requested symbol.
  const unlisted = Boolean(trimmedQuery) && !tickers.some((ticker) =>
    ticker.symbol === trimmedQuery.toUpperCase())
  const search = useSymbolSearch(trimmedQuery, unlisted)
  const lookup = search.status === 'found' ? search.lookup : undefined
  const found = search.status === 'found' ? tickerFromPublic(search.lookup.ticker) : undefined
  const universe = found && !matched.some((ticker) => ticker.symbol === found.symbol)
    ? [found, ...matched]
    : matched
  const relevance = Boolean(trimmedQuery) && !searchSort
  const watchTickers = [...universe].sort((left, right) =>
    Number(pinned.has(right.symbol)) - Number(pinned.has(left.symbol))
    || (relevance ? 0 : compareBySort(left, right, sort)
      || left.symbol.localeCompare(right.symbol)))
  const selectResult = useCallback((symbol: string) => {
    onSelectTicker(symbol, lookup?.ticker.symbol === symbol ? lookup : undefined)
  }, [onSelectTicker, lookup])
  const toggleResultPinned = useCallback((symbol: string) => {
    onTogglePinned(symbol, lookup?.ticker.symbol === symbol ? lookup : undefined)
  }, [onTogglePinned, lookup])
  // Looking at a symbol with an empty month asks the server to go and find out. What comes
  // back joins the calendar on this visit rather than waiting for the next snapshot.
  const catalystSearch = useCatalystSearch(selected.symbol, catalysts, now)
  const focusedCatalysts = usePublicCatalysts(selected.symbol)
  // The year series is fetched only where something draws it: the table's year column at the
  // wide breakpoint, and every phone row, which has the room the table's middle widths lack.
  const yearCloses = useYearCandles(useMediaQuery(WIDE_VIEWPORT) || narrow)
  const cycleListMetric = useCallback(() => {
    setListMetric((current) => LIST_METRICS[(LIST_METRICS.indexOf(current) + 1) % LIST_METRICS.length]!)
  }, [])
  // A tap on a phone both selects and opens the detail, as a stocks app does; a wide screen
  // keeps the card beside the list and only selects.
  const selectFromList = useCallback((symbol: string) => {
    selectResult(symbol)
    if (narrow) setDetailOpen(true)
  }, [narrow, selectResult])
  // The search state is a new object on every render, so the merge watches the catalysts a
  // found symbol carried rather than the state that carried them, and holds between searches.
  const looked = search.status === 'found' ? search.lookup.catalysts : undefined
  const visibleCatalysts = useMemo(() => {
    // Later rows win by id, so a row a search just bound replaces the snapshot's copy of it.
    const merged = new Map(
      [...catalysts, ...(looked ?? []), ...catalystSearch.catalysts, ...focusedCatalysts]
        .map((catalyst) => [catalyst.id, catalyst]),
    )
    return [...merged.values()]
  }, [catalysts, catalystSearch.catalysts, focusedCatalysts, looked])
  const nextCatalysts = nextCatalystsBySymbol(visibleCatalysts, now)
  const toggleSort = (column: typeof SORT_COLUMNS[number]) => {
    setSearchSort(true)
    setSort((current) => current.key === column.key
      ? { direction: current.direction === 'asc' ? 'desc' : 'asc', key: column.key }
      : { direction: column.defaultDirection, key: column.key })
  }
  const pinnedTickers = tickers.filter((ticker) => pinned.has(ticker.symbol))
  const selectedVerdict = volatilityVerdict(selected)
  const selectedCopy = verdictCopy[selectedVerdict]
  const selectedPremiumScore = premiumScore(selected)
  const selectedAsset = assetLabel(selected)
  const selectedRecommendation = dailyRecommendations?.recommendations.find(
    (recommendation) => recommendation.symbol === selected.symbol,
  )
  const selectedTape = focusTape(selected)
  // Two ages, because they are two facts: the quote moves with the market, while the provider
  // recomputes volatility and liquidity on its own schedule and can leave them hours behind.
  // One "updated" label for the card would let the newer of the two vouch for the older.
  const quoteAge = useElapsedLabel(selected.updatedAt)
  const metricsAge = useElapsedLabel(selected.metricsUpdatedAt)
  const selectedCatalyst = nextCatalysts.get(selected.symbol)
  const selectedRank = formatIfReported(selected.ivRank, formatMarketMetric)

  const focusCard = (
      <Card className={cn('instrument-focus', selectedVerdict)} variant="flat" aria-labelledby="selected-instrument-title">
        <CardHeader>
          <div className="selected-summary">
            <div className="selected-instrument">
              <h2 className="selected-symbol" id="selected-instrument-title">{selected.symbol}</h2>
              <p>{issuerName(selected.name)}{selectedAsset ? ` · ${selectedAsset}` : ''}</p>
            </div>
            <div className="selected-price">
              <strong>{formatMarketPrice(selected.price)}</strong>
              <span>{formatSignedMetric(selected.changePercent, '%')}</span>
            </div>
          </div>
          {/* The premium verdict keeps the product's gradient axis, at a scale that
              leaves the recommendation and the runway as the panel's primary reading. */}
          <div className="premium-gauge">
            <span>Option premium</span>
            <strong className="premium-verdict">{selectedCopy}</strong>
            {selectedPremiumScore === undefined ? null : (
              <Progress className="premium-axis" aria-label={`Relative premium score ${selectedPremiumScore} out of 100, from cheap to expensive`} value={selectedPremiumScore} />
            )}
          </div>
        </CardHeader>
        <CardContent className="focus-narrative">
          {selectedRecommendation && <RecommendationPanel recommendation={selectedRecommendation} />}
          <CatalystRunway
            catalysts={visibleCatalysts}
            now={now}
            onRefresh={owner ? catalystSearch.refresh : undefined}
            searching={catalystSearch.searching}
            symbol={selected.symbol}
          />
          <EvidenceCards symbol={selected.symbol} />
        </CardContent>
        <CardFooter>
          <dl className="focus-tape" aria-label={`${selected.symbol} metrics`}>
            {selectedTape.map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
            ))}
          </dl>
          <p className="focus-freshness">
            <span>Quote <time dateTime={selected.updatedAt}>{quoteAge}</time></span>
            <span>
              {'IV & liquidity '}
              {selected.metricsUpdatedAt
                ? <time dateTime={selected.metricsUpdatedAt}>{metricsAge}</time>
                : 'age not reported'}
            </span>
          </p>
        </CardFooter>
      </Card>
  )

  return (
    <div className="market-screen">
      {/* A phone has no row to spare for an empty rail; the star on every row says what pinning does. */}
      {(!narrow || pinnedTickers.length > 0) && (
        <CatalystStories catalysts={visibleCatalysts} now={now} onSelect={selectFromList} tickers={pinnedTickers} />
      )}

      {narrow ? (
        <>
          {/* The selected name in two lines, so the list can be the screen without losing the
              reading a tap just changed. The full card is one tap away in the sheet. */}
          <button
            aria-label={`Open ${selected.symbol} detail`}
            className={cn('focus-strip', selectedVerdict)}
            onClick={() => setDetailOpen(true)}
            type="button"
          >
            <span className="focus-strip-name">
              <strong className="focus-strip-symbol">{selected.symbol}</strong>
              <small>{issuerName(selected.name)}</small>
            </span>
            <span className="focus-strip-quote">
              <strong>{formatMarketPrice(selected.price)}</strong>
              <small data-tone={selected.changePercent > 0 ? 'up' : selected.changePercent < 0 ? 'down' : 'flat'}>
                {formatSignedMetric(selected.changePercent, '%')}
              </small>
            </span>
            <span className="focus-strip-read">
              <em className="strip-verdict">{selectedCopy}</em>
              {selectedRank === undefined ? '' : ` ${selectedRank}`}
              {formatIfReported(selected.ivIndex, (iv) => ` · IV ${formatMarketMetric(iv)}%`) ?? ''}
              {selectedCatalyst ? ` · ${catalystLabel(selectedCatalyst, now)}` : ''}
            </span>
            <ChevronRight aria-hidden="true" />
          </button>
          <Drawer onOpenChange={setDetailOpen} open={detailOpen} showSwipeHandle>
            <DrawerContent className="focus-sheet">
              <DrawerTitle className="sr-only">{selected.symbol} detail</DrawerTitle>
              {/* The pin travels with the card, so a reader deciding on a name in the sheet
                  need not go back to the row to keep it. */}
              <PinButton
                className="focus-sheet-pin"
                onToggle={onTogglePinned}
                pinned={pinned.has(selected.symbol)}
                symbol={selected.symbol}
              />
              <DrawerClose aria-label="Close detail" className="focus-sheet-close">
                <X aria-hidden="true" />
              </DrawerClose>
              <div className="focus-sheet-scroll">{focusCard}</div>
            </DrawerContent>
          </Drawer>
        </>
      ) : focusCard}

      <section
        className="watch-table"
        aria-label={activeWatchlist.kind === 'public' ? activeWatchlist.name : undefined}
        aria-labelledby={activeWatchlist.kind === 'private' ? 'watch-title' : undefined}
      >
        <header className="section-header">
          <h2 className="watchlist-title" id="watch-title">{activeWatchlist.kind === 'public' ? 'Watchlist' : activeWatchlist.name}</h2>
          <div className="watch-search">
            <Search aria-hidden="true" />
            <input
              aria-label="Search all symbols"
              name="symbol-search"
              onChange={(event) => {
                setQuery(event.target.value)
                setSearchSort(false)
              }}
              placeholder="Search all symbols"
              type="search"
              value={query}
            />
          </div>
          {narrow && <SortControl onChange={(next) => {
            setSort(next)
            setSearchSort(true)
          }} sort={sort} relevance={relevance} />}
        </header>
        {trimmedQuery && watchTickers.length > 0 && search.status === 'failed' && (
          <p role="status">Symbol search is unavailable. Showing the loaded list only.</p>
        )}
        {narrow ? (
          <ol className="watch-list">
            {watchTickers.map((ticker) => (
              <MarketListRow
                catalyst={nextCatalysts.get(ticker.symbol)}
                isPinned={pinned.has(ticker.symbol)}
                isSelected={ticker.symbol === selected.symbol}
                key={ticker.symbol}
                metric={listMetric}
                now={now}
                onCycleMetric={cycleListMetric}
                onSelectTicker={selectFromList}
                onTogglePinned={toggleResultPinned}
                ticker={ticker}
                yearCloses={yearCloses.get(ticker.symbol)}
              />
            ))}
            {!watchTickers.length && (
              <li>
                <Empty className="watch-empty">
                  <EmptyHeader>
                    <EmptyDescription>
                      {searchEmptyMessage(trimmedQuery, search.status)}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </li>
            )}
          </ol>
        ) : (
        <Table className="premium-data-table">
          <TableHeader>
            <TableRow>
              <TableHead><span className="sr-only">Pinned</span></TableHead>
              {SORT_COLUMNS.map((column) => (
                <TableHead
                  aria-sort={!relevance && sort.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={column.key === 'year' ? 'year-cell' : undefined}
                  key={column.key}
                >
                  <button className="sort-button" onClick={() => toggleSort(column)} type="button">
                    {column.label}
                    {!relevance && sort.key === column.key && (sort.direction === 'asc'
                      ? <ArrowUp aria-hidden="true" />
                      : <ArrowDown aria-hidden="true" />)}
                  </button>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {watchTickers.map((ticker) => (
              <MarketTickerRow
                catalyst={nextCatalysts.get(ticker.symbol)}
                isPinned={pinned.has(ticker.symbol)}
                isSelected={ticker.symbol === selected.symbol}
                key={ticker.symbol}
                now={now}
                onSelectTicker={selectResult}
                onTogglePinned={toggleResultPinned}
                ticker={ticker}
                yearCloses={yearCloses.get(ticker.symbol)}
              />
            ))}
            {!watchTickers.length && (
              <TableRow>
                <TableCell colSpan={SORT_COLUMNS.length + 1}>
                  <Empty className="watch-empty">
                    <EmptyHeader>
                      <EmptyDescription>
                        {searchEmptyMessage(trimmedQuery, search.status)}
                      </EmptyDescription>
                    </EmptyHeader>
                  </Empty>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        )}
      </section>
    </div>
  )
}
