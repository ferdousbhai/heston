import { memo, useMemo, useState, useSyncExternalStore } from 'react'
import { ArrowDown, ArrowUp, ArrowUpRight, Search, Star } from 'lucide-react'
import { matchSorter } from 'match-sorter'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader } from '#/components/ui/card'
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
  termStructureSpread,
  volatilityVerdict,
  type IvTermStructure,
  type DailyRecommendations,
  type Ticker,
  type VolatilityVerdict,
  type Watchlist,
} from '../domain/market'
import { useCatalystSearch } from '../data/catalyst-refresh'
import { useYearCandles } from '../data/year-candles'
import { useSymbolSearch, type SymbolSearchState } from '../data/symbol-search'
import { CatalystStories } from './catalyst-stories'

const verdictCopy = {
  cheap: { label: 'Cheap' },
  fair: { label: 'Fair' },
  rich: { label: 'Expensive' },
  unavailable: { label: 'Unavailable' },
} satisfies Record<VolatilityVerdict, { label: string }>

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

function useWideViewport(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      // A renderer without matchMedia — jsdom, or a server pass — reports a narrow viewport,
      // so nothing asks for history behind a column it was never going to draw.
      const query = window.matchMedia?.(WIDE_VIEWPORT)
      query?.addEventListener('change', onChange)
      return () => query?.removeEventListener('change', onChange)
    },
    () => window.matchMedia?.(WIDE_VIEWPORT).matches ?? false,
    () => false,
  )
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

function Sparkline({ points }: { points: readonly CandlePoint[] }) {
  const session = latestSessionCandles(points)
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
        ` Nothing is on ${symbol}'s calendar yet, so Spice is searching for scheduled ${CATALYST_SCOPE} dates.`,
      ]
    : [
        'Nothing is on the calendar.',
        ` Spice tracks ${CATALYST_SCOPE} dates for ${symbol}, and none are scheduled. A re-rating from here would have to come from something unannounced.`,
      ]
  return (
    <div className="runway-empty" aria-live="polite">
      <p><strong>{heading}</strong>{detail}</p>
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
                      <p className="runway-kind">
                        {[catalystKindName(catalyst.kind), catalystTimingLabel(catalyst.timing), catalyst.confidence]
                          .filter(Boolean)
                          .join(' · ')}
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
  const type = assetLabel(ticker)
  const ivRank = ticker.ivRank === undefined ? '—' : formatMarketMetric(ticker.ivRank)

  return (
    <TableRow data-state={isSelected ? 'selected' : undefined}>
      <TableCell className="pin-cell">
        <Button
          aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${ticker.symbol}`}
          aria-pressed={isPinned}
          className={cn('pin-button', isPinned && 'pinned')}
          onClick={() => onTogglePinned(ticker.symbol)}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Star aria-hidden="true" fill={isPinned ? 'currentColor' : 'none'} />
        </Button>
      </TableCell>
      <TableCell className="instrument-cell">
        <Button
          aria-label={`${ticker.symbol}, ${issuerName(ticker.name)}, ${ticker.position ? 'held, ' : ''}${copy.label} option premium, IV rank ${ivRank}`}
          aria-pressed={isSelected}
          className="ticker-table-button"
          onClick={() => onSelectTicker(ticker.symbol)}
          type="button"
          variant="ghost"
        >
          {/* `position` is false for every public reader, so this marker is owner-only by construction. */}
          <span>
            <strong>{ticker.symbol}</strong>
            {type ? <small>{type}</small> : null}
            {ticker.position ? <small className="held-marker">Held</small> : null}
          </span>
          <small>{issuerName(ticker.name)}</small>
          {catalyst ? <small>{catalystLabel(catalyst, now)}</small> : null}
        </Button>
      </TableCell>
      <TableCell className="market-cap-cell">
        <strong>{compactMetric(ticker.marketCap, '$')}</strong>
      </TableCell>
      <TableCell className="price-cell">
        <div className="price-session">
          {/* Snapshot quotes carry two synthetic endpoints; only render a chart for a richer live candle series. */}
          {ticker.sparkline.length > 2 ? <Sparkline points={ticker.sparkline} /> : null}
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
        <strong>{copy.label}</strong>
        <small>{formatIfReported(ticker.ivIndex, (iv) => `${formatMarketMetric(iv)}% IV`) ?? '—'}</small>
        <small>{formatIfReported(ticker.ivRank, (rank) => `${formatMarketMetric(rank)} rank`) ?? '—'}</small>
      </TableCell>
      <TableCell className="liquidity-cell">
        <strong>{formatIfReported(ticker.liquidity, (liquidity) => `${formatMarketMetric(liquidity)}/5`) ?? '—'}</strong>
        {ticker.lendability ? <small>{ticker.lendability}</small> : null}
      </TableCell>
    </TableRow>
  )
})

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
  onSelectTicker: (symbol: string) => void
  onTogglePinned: (symbol: string) => void
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
  const pinned = new Set(pinnedSymbols)
  const trimmedQuery = query.trim()
  const matched = trimmedQuery
    ? matchSorter(tickers, trimmedQuery, { keys: ['symbol', 'name'] })
    : activeWatchlist.symbols.flatMap((symbol) => {
        const ticker = tickers.find((candidate) => candidate.symbol === symbol)
        return ticker ? [ticker] : []
      })
  // The loaded list is a slice of the market, so a search it cannot answer is put to the
  // catalog instead of being reported as nothing. What comes back has joined the
  // maintained list, so it is an ordinary row that later snapshots keep carrying.
  const unlisted = Boolean(trimmedQuery) && !matched.length
  const search = useSymbolSearch(trimmedQuery, unlisted)
  const universe = unlisted && search.status === 'found'
    ? [{ ...search.lookup.ticker, position: false }]
    : matched
  const watchTickers = [...universe].sort((left, right) =>
    Number(pinned.has(right.symbol)) - Number(pinned.has(left.symbol))
    || compareBySort(left, right, sort)
    || left.symbol.localeCompare(right.symbol))
  // Looking at a symbol with an empty month asks the server to go and find out. What comes
  // back joins the calendar on this visit rather than waiting for the next snapshot.
  const catalystSearch = useCatalystSearch(selected.symbol, catalysts, now)
  // The year column only exists at the wide breakpoint, so its history is only fetched there.
  // A phone never spends a request on a chart it has no room to draw.
  const yearCloses = useYearCandles(useWideViewport())
  // The search state is a new object on every render, so the merge watches the catalysts a
  // found symbol carried rather than the state that carried them, and holds between searches.
  const looked = search.status === 'found' ? search.lookup.catalysts : undefined
  const visibleCatalysts = useMemo(() => {
    // Later rows win by id, so a row a search just bound replaces the snapshot's copy of it.
    const merged = new Map([...catalysts, ...(looked ?? []), ...catalystSearch.catalysts]
      .map((catalyst) => [catalyst.id, catalyst]))
    return [...merged.values()]
  }, [catalysts, catalystSearch.catalysts, looked])
  const nextCatalysts = nextCatalystsBySymbol(visibleCatalysts, now)
  const toggleSort = (column: typeof SORT_COLUMNS[number]) => {
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

  return (
    <div className="market-screen">
      <CatalystStories catalysts={visibleCatalysts} now={now} onSelect={onSelectTicker} tickers={pinnedTickers} />

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
            <strong className="premium-verdict">{selectedCopy.label}</strong>
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
        </CardContent>
        <CardFooter>
          <dl className="focus-tape" aria-label={`${selected.symbol} metrics`}>
            {selectedTape.map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        </CardFooter>
      </Card>

      <section
        className="watch-table"
        aria-label={activeWatchlist.kind === 'public' ? activeWatchlist.name : undefined}
        aria-labelledby={activeWatchlist.kind === 'private' ? 'watch-title' : undefined}
      >
        <header className="section-header">
          {activeWatchlist.kind === 'private' && (
            <h2 className="watchlist-title" id="watch-title">{activeWatchlist.name}</h2>
          )}
          <div className="watch-search">
            <Search aria-hidden="true" />
            <input
              aria-label="Search all symbols"
              name="symbol-search"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search all symbols"
              type="search"
              value={query}
            />
          </div>
        </header>
        <Table className="premium-data-table">
          <TableHeader>
            <TableRow>
              <TableHead><span className="sr-only">Pinned</span></TableHead>
              {SORT_COLUMNS.map((column) => (
                <TableHead
                  aria-sort={sort.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={column.key === 'year' ? 'year-cell' : undefined}
                  key={column.key}
                >
                  <button className="sort-button" onClick={() => toggleSort(column)} type="button">
                    {column.label}
                    {sort.key === column.key && (sort.direction === 'asc'
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
                onSelectTicker={onSelectTicker}
                onTogglePinned={onTogglePinned}
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
      </section>
    </div>
  )
}
