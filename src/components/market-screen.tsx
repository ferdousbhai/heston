import { memo, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpRight, Search, Settings2, Star } from 'lucide-react'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '#/components/ui/tooltip'
import { cn } from '#/lib/utils'
import { type CandlePoint } from '../domain/candle'
import {
  CATALYST_KIND_NAMES,
  catalystCountdown,
  catalystKindName,
  catalystLabel,
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
  instrumentSignals,
  termStructureSpread,
  volatilityVerdict,
  type IvTermStructure,
  type ResearchBrief,
  type Ticker,
  type VolatilityVerdict,
  type Watchlist,
} from '../domain/market'
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

const borrowRateFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 4,
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

function formatBorrowRate(rate: number): string {
  return `${borrowRateFormatter.format(rate)}%`
}

function borrowRateDetail(rate: number): string {
  return rate === 0 ? 'Reported 0%' : `${formatBorrowRate(rate)} borrow`
}

type SortDirection = 'asc' | 'desc'
type SortKey = 'symbol' | 'marketCap' | 'price' | 'volume' | 'premium' | 'rank' | 'liquidity'

const SORT_COLUMNS: { defaultDirection: SortDirection; key: SortKey; label: string }[] = [
  { defaultDirection: 'asc', key: 'symbol', label: 'Instrument' },
  { defaultDirection: 'desc', key: 'marketCap', label: 'Market cap' },
  { defaultDirection: 'desc', key: 'price', label: 'Price' },
  { defaultDirection: 'desc', key: 'volume', label: 'Volume' },
  { defaultDirection: 'desc', key: 'premium', label: 'Option premium' },
  { defaultDirection: 'desc', key: 'rank', label: 'IV rank' },
  { defaultDirection: 'desc', key: 'liquidity', label: 'Liquidity' },
]

function Sparkline({ points }: { points: readonly CandlePoint[] }) {
  const closes = points.map((point) => point.close)
  const low = Math.min(...closes)
  const span = Math.max(...closes) - low || 1
  const step = closes.length > 1 ? 100 / (closes.length - 1) : 0
  const line = closes
    .map((close, index) => `${(index * step).toFixed(2)},${(23 - ((close - low) / span) * 21).toFixed(2)}`)
    .join(' ')
  return (
    <svg aria-hidden="true" className="sparkline" preserveAspectRatio="none" viewBox="0 0 100 26">
      <polyline points={line} />
    </svg>
  )
}

const SORT_METRICS = {
  marketCap: (ticker) => ticker.marketCap,
  price: (ticker) => ticker.price,
  volume: (ticker) => ticker.volume,
  premium: premiumScore,
  rank: (ticker) => ticker.ivRank,
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
    ['Borrow', formatIfReported(ticker.borrowRate, formatBorrowRate)],
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

const CATALYST_SCOPE = `${CATALYST_KIND_NAMES.slice(0, -1).join(', ')} and ${CATALYST_KIND_NAMES.at(-1)}`

function ThesisPanel({ idea }: { idea: ResearchBrief['ideas'][number] }) {
  return (
    <section className="focus-thesis" aria-labelledby="focus-thesis-title">
      <header className="focus-eyebrow">
        <h3 id="focus-thesis-title">Thesis</h3>
        <Badge variant={idea.direction}>{idea.direction}</Badge>
      </header>
      <p className="thesis-headline">{idea.headline}</p>
      <p className="thesis-body">{idea.description}</p>
      <p className="thesis-risk"><span>What breaks it</span>{idea.risk}</p>
      {idea.play && <p className="thesis-play"><span>Illustrative play</span><strong>{idea.play}</strong></p>}
      {idea.sources.length > 0 && (
        <p className="thesis-sources">
          {idea.sources.map((source) => (
            <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
              {source.label}<ArrowUpRight aria-hidden="true" />
            </a>
          ))}
        </p>
      )}
    </section>
  )
}

function CatalystRunway({
  catalysts,
  now,
  symbol,
}: {
  catalysts: readonly Catalyst[]
  now: Date
  symbol: string
}) {
  const upcoming = upcomingCatalystsForSymbol(symbol, catalysts, now)

  return (
    <section className="focus-runway" aria-labelledby="focus-runway-title">
      <header className="focus-eyebrow">
        <h3 id="focus-runway-title">What&rsquo;s coming</h3>
      </header>
      {upcoming.length
        ? (
            <ol className="runway">
              {upcoming.map((catalyst, index) => (
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
                    <a href={catalyst.sourceUrl} rel="noreferrer" target="_blank">
                      {catalyst.source}<ArrowUpRight aria-hidden="true" />
                    </a>
                  </div>
                </li>
              ))}
            </ol>
          )
        : (
            <p className="runway-empty">
              <strong>Nothing is on the calendar.</strong>
              {` Spice tracks ${CATALYST_SCOPE} dates for ${symbol}, and none are scheduled. A re-rating from here would have to come from something unannounced.`}
            </p>
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
}: {
  catalyst: Catalyst | undefined
  isPinned: boolean
  isSelected: boolean
  now: Date
  onSelectTicker: (symbol: string) => void
  onTogglePinned: (symbol: string) => void
  ticker: Ticker
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
          aria-label={`${ticker.symbol}, ${ticker.name}, ${ticker.position ? 'held, ' : ''}${copy.label} option premium, IV rank ${ivRank}`}
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
          <small>{ticker.name}</small>
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
        {rangePosition === undefined
          ? <small>52w range unavailable</small>
          : <Progress className="price-range" aria-label={`${Math.round(rangePosition)}% of 52-week range`} value={rangePosition} />}
      </TableCell>
      {/* tastytrade reports equity day share volume here, not 24-hour or option-contract volume. */}
      <TableCell className="volume-cell">
        <strong>{compactMetric(ticker.volume, '', ' shares')}</strong>
      </TableCell>
      <TableCell className={`premium-cell ${verdict}`}>
        <strong>{copy.label}</strong>
        <small>{formatIfReported(ticker.ivIndex, (iv) => `${formatMarketMetric(iv)}% IV`) ?? '—'}</small>
        <small>{formatSignedMetric(ticker.ivIndex5DayChange, ' pts 5d')}</small>
      </TableCell>
      <TableCell className="rank-cell">
        <strong>{ivRank}</strong>
        <small>{formatIfReported(ticker.ivPercentile, (percentile) => `${formatMarketMetric(percentile)} pct`) ?? '—'}</small>
      </TableCell>
      <TableCell className="liquidity-cell">
        <strong>{formatIfReported(ticker.liquidity, (liquidity) => `${formatMarketMetric(liquidity)}/5`) ?? '—'}</strong>
        <small>{ticker.lendability ?? 'Lendability unavailable'}</small>
        <small>{ticker.borrowRate === undefined ? 'Rate unavailable' : borrowRateDetail(ticker.borrowRate)}</small>
      </TableCell>
    </TableRow>
  )
})

export function MarketScreen({
  activeWatchlist,
  catalysts,
  onManageWatchlist,
  onSelectTicker,
  onTogglePinned,
  pinnedSymbols,
  research,
  selected,
  tickers,
}: {
  activeWatchlist: Watchlist
  catalysts: Catalyst[]
  onManageWatchlist: () => void
  onSelectTicker: (symbol: string) => void
  onTogglePinned: (symbol: string) => void
  pinnedSymbols: readonly string[]
  research?: ResearchBrief
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
  const universe = trimmedQuery
    ? matchSorter(tickers, trimmedQuery, { keys: ['symbol', 'name'] })
    : activeWatchlist.symbols.flatMap((symbol) => {
        const ticker = tickers.find((candidate) => candidate.symbol === symbol)
        return ticker ? [ticker] : []
      })
  const watchTickers = [...universe].sort((left, right) =>
    Number(pinned.has(right.symbol)) - Number(pinned.has(left.symbol))
    || compareBySort(left, right, sort)
    || left.symbol.localeCompare(right.symbol))
  const nextCatalysts = nextCatalystsBySymbol(catalysts, now)
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
  const selectedIdea = research?.ideas.find((idea) => idea.symbol === selected.symbol)
  const selectedSignals = instrumentSignals(selected)
  const selectedTape = focusTape(selected)

  return (
    <div className="market-screen">
      <CatalystStories catalysts={catalysts} now={now} onSelect={onSelectTicker} tickers={pinnedTickers} />

      <Card className={cn('instrument-focus', selectedVerdict)} variant="flat" aria-labelledby="selected-instrument-title">
        <CardHeader>
          <div className="selected-summary">
            <div className="selected-instrument">
              <h2 className="selected-symbol" id="selected-instrument-title">{selected.symbol}</h2>
              <p>{selected.name}{selectedAsset ? ` · ${selectedAsset}` : ''}</p>
            </div>
            <div className="selected-price">
              <strong>{formatMarketPrice(selected.price)}</strong>
              <span>{formatSignedMetric(selected.changePercent, '%')}</span>
            </div>
          </div>
          {/* The premium verdict keeps the product's gradient axis, at a scale that
              leaves the thesis and the runway as the panel's primary reading. */}
          <div className="premium-gauge">
            <span>Option premium</span>
            <strong className="premium-verdict">{selectedCopy.label}</strong>
            {selectedPremiumScore === undefined ? null : (
              <Progress className="premium-axis" aria-label={`Relative premium score ${selectedPremiumScore} out of 100, from cheap to expensive`} value={selectedPremiumScore} />
            )}
          </div>
        </CardHeader>
        <CardContent className={cn('focus-narrative', selectedIdea && 'with-thesis', !selectedIdea && selectedSignals.length === 0 && 'runway-only')}>
          <div className="focus-context">
            {selectedIdea && <ThesisPanel idea={selectedIdea} />}
            {/* In-band instruments omit this section entirely; the tape still reports their available metrics. */}
            {selectedSignals.length > 0 && (
              <section className="focus-signals" aria-labelledby="focus-signals-title">
                <header className="focus-eyebrow">
                  <h3 id="focus-signals-title">What stands out</h3>
                </header>
                <ul className="signal-list">
                  {selectedSignals.map((signal) => (
                    <li className={cn('signal', signal.tone)} key={signal.key}>
                      <strong>{signal.label}</strong>
                      <span>{signal.detail}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
          <CatalystRunway catalysts={catalysts} now={now} symbol={selected.symbol} />
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
          {activeWatchlist.kind === 'private' && (
            <Tooltip>
              <TooltipTrigger render={<Button className="watchlist-manage-button" onClick={onManageWatchlist} size="icon-lg" type="button" variant="outline" />}>
                <Settings2 aria-hidden="true" />
                <span className="sr-only">Manage {activeWatchlist.name}</span>
              </TooltipTrigger>
              <TooltipContent>Manage {activeWatchlist.name}</TooltipContent>
            </Tooltip>
          )}
        </header>
        <Table className="premium-data-table">
          <TableHeader>
            <TableRow>
              <TableHead><span className="sr-only">Pinned</span></TableHead>
              {SORT_COLUMNS.map((column) => (
                <TableHead
                  aria-sort={sort.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
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
              />
            ))}
            {!watchTickers.length && (
              <TableRow>
                <TableCell colSpan={SORT_COLUMNS.length + 1}>
                  <Empty className="watch-empty">
                    <EmptyHeader>
                      <EmptyDescription>
                        {trimmedQuery ? 'No loaded symbol matches your search.' : 'No option metrics are available for this list.'}
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
