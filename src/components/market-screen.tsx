import { useState } from 'react'
import { ArrowDown, ArrowUp, Search, Settings2, Star } from 'lucide-react'
import { matchSorter } from 'match-sorter'

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
import { catalystLabel, nextCatalystForSymbol, type Catalyst } from '../domain/catalyst'
import {
  fiftyTwoWeekPosition,
  formatMarketMetric,
  volatilityVerdict,
  type Ticker,
  type VolatilityVerdict,
  type Watchlist,
} from '../domain/market'
import { CatalystStories } from './catalyst-stories'

const verdictCopy = {
  cheap: { label: 'Cheap' },
  fair: { label: 'Fair' },
  rich: { label: 'Expensive' },
} satisfies Record<VolatilityVerdict, { label: string }>

function premiumScore(ticker: Pick<Ticker, 'ivRank' | 'ivPercentile'>): number {
  return Math.round((ticker.ivRank + ticker.ivPercentile) / 2)
}

const priceFormatter = new Intl.NumberFormat('en-US', {
  currency: 'USD',
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
  style: 'currency',
})

const compactFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  notation: 'compact',
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

function borrowLabel(ticker: Pick<Ticker, 'borrowRate' | 'lendability'>): string {
  if (ticker.borrowRate !== undefined) return `${formatMarketMetric(ticker.borrowRate)}% borrow`
  return ticker.lendability ?? '—'
}

type SortDirection = 'asc' | 'desc'
type SortKey = 'symbol' | 'trend' | 'premium' | 'rank' | 'liquidity' | 'activity' | 'range'

const SORT_COLUMNS: { defaultDirection: SortDirection; key: SortKey; label: string }[] = [
  { defaultDirection: 'asc', key: 'symbol', label: 'Instrument' },
  { defaultDirection: 'desc', key: 'trend', label: 'Session' },
  { defaultDirection: 'desc', key: 'premium', label: 'Option premium' },
  { defaultDirection: 'desc', key: 'rank', label: 'IV rank' },
  { defaultDirection: 'desc', key: 'liquidity', label: 'Liquidity' },
  { defaultDirection: 'desc', key: 'activity', label: 'Activity' },
  { defaultDirection: 'desc', key: 'range', label: '52-week range' },
]

/**
 * The stroke stays neutral: green and red are already spoken for by the
 * premium verdict, and the shape plus the signed percentage carry direction.
 */
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

/**
 * Traded notional, the closest activity proxy the snapshot carries: tastytrade
 * reports equity day volume, never option contract volume.
 */
function dollarVolume(ticker: Pick<Ticker, 'price' | 'volume'>): number | undefined {
  return ticker.volume === undefined ? undefined : ticker.volume * ticker.price
}

const SORT_METRICS = {
  trend: (ticker) => ticker.changePercent,
  premium: premiumScore,
  rank: (ticker) => ticker.ivRank,
  liquidity: (ticker) => ticker.liquidity,
  activity: dollarVolume,
  range: fiftyTwoWeekPosition,
} satisfies Record<Exclude<SortKey, 'symbol'>, (ticker: Ticker) => number | undefined>

function compareBySort(left: Ticker, right: Ticker, sort: { direction: SortDirection; key: SortKey }): number {
  if (sort.key === 'symbol') {
    const delta = left.symbol.localeCompare(right.symbol)
    return sort.direction === 'asc' ? delta : -delta
  }
  const leftValue = SORT_METRICS[sort.key](left)
  const rightValue = SORT_METRICS[sort.key](right)
  // An unreported metric sinks below every ranked row, in either direction.
  if (leftValue === undefined || rightValue === undefined) {
    return Number(leftValue === undefined) - Number(rightValue === undefined)
  }
  const delta = leftValue - rightValue
  return sort.direction === 'asc' ? delta : -delta
}

function termStructureLabel(ticker: Pick<Ticker, 'ivTermStructure'>): string {
  const term = ticker.ivTermStructure
  if (!term) return '—'
  const spread = term.frontIv - term.backIv
  if (Math.abs(spread) < 1) return 'Flat'
  return spread > 0
    ? `Front +${formatMarketMetric(spread)} pts`
    : `Back +${formatMarketMetric(Math.abs(spread))} pts`
}

export function MarketScreen({
  activeWatchlist,
  catalysts,
  onManageWatchlist,
  onSelectTicker,
  onTogglePinned,
  pinnedSymbols,
  selected,
  tickers,
}: {
  activeWatchlist: Watchlist
  catalysts: Catalyst[]
  onManageWatchlist: () => void
  onSelectTicker: (symbol: string) => void
  onTogglePinned: (symbol: string) => void
  pinnedSymbols: readonly string[]
  selected: Ticker
  tickers: Ticker[]
}) {
  const now = new Date()
  const [sort, setSort] = useState<{ direction: SortDirection; key: SortKey }>({ direction: 'desc', key: 'activity' })
  const [query, setQuery] = useState('')
  const pinned = new Set(pinnedSymbols)
  const trimmedQuery = query.trim()
  // A search reaches every loaded instrument; an empty query shows the active
  // watchlist. match-sorter supplies the fuzzy matching; the active column, not
  // its relevance ranking, still orders the rows so the sort indicator holds.
  const universe = trimmedQuery
    ? matchSorter(tickers, trimmedQuery, { keys: ['symbol', 'name'] })
    : activeWatchlist.symbols.flatMap((symbol) => {
        const ticker = tickers.find((candidate) => candidate.symbol === symbol)
        return ticker ? [ticker] : []
      })
  // Pinned rows hold the top of the table whichever column is sorted.
  const watchTickers = [...universe].sort((left, right) =>
    Number(pinned.has(right.symbol)) - Number(pinned.has(left.symbol))
    || compareBySort(left, right, sort)
    || left.symbol.localeCompare(right.symbol))
  const toggleSort = (column: typeof SORT_COLUMNS[number]) => {
    setSort((current) => current.key === column.key
      ? { direction: current.direction === 'asc' ? 'desc' : 'asc', key: column.key }
      : { direction: column.defaultDirection, key: column.key })
  }
  const pinnedTickers = tickers.filter((ticker) => pinned.has(ticker.symbol))
  const selectedVerdict = volatilityVerdict(selected)
  const selectedCopy = verdictCopy[selectedVerdict]
  const selectedAsset = assetLabel(selected)
  const selectedRangePosition = fiftyTwoWeekPosition(selected)

  return (
    <div className="market-screen">
      <CatalystStories catalysts={catalysts} now={now} onSelect={onSelectTicker} tickers={pinnedTickers} />

      <Card className={cn('premium-focus', selectedVerdict)} variant="flat" aria-labelledby="selected-premium-title">
        <CardHeader>
          <div className="selected-instrument">
            <h2 className="selected-symbol">{selected.symbol}</h2>
            <p>{selected.name}{selectedAsset ? ` · ${selectedAsset}` : ''}</p>
          </div>
        </CardHeader>
        <CardContent>
          <strong className="premium-focus-verdict" id="selected-premium-title">{selectedCopy.label}</strong>
          <Progress className="premium-axis" aria-label={`Relative premium score ${premiumScore(selected)} out of 100, from cheap to expensive`} value={premiumScore(selected)} />
        </CardContent>
        <CardFooter>
          <div className="premium-details">
            <dl className="premium-stats">
              <div><dt>Current IV</dt><dd>{formatMarketMetric(selected.ivIndex)}%</dd></div>
              <div><dt>IV rank</dt><dd>{formatMarketMetric(selected.ivRank)}</dd></div>
              <div><dt>IV percentile</dt><dd>{formatMarketMetric(selected.ivPercentile)}</dd></div>
              <div><dt>IV 5-day</dt><dd>{formatSignedMetric(selected.ivIndex5DayChange, ' pts')}</dd></div>
              <div><dt>30-day HV</dt><dd>{selected.historicalVolatility30Day === undefined ? '—' : `${formatMarketMetric(selected.historicalVolatility30Day)}%`}</dd></div>
              <div><dt>IV minus HV</dt><dd>{formatSignedMetric(selected.ivHistoricalVolatility30DayDifference, ' pts')}</dd></div>
              <div><dt>Term structure</dt><dd>{termStructureLabel(selected)}</dd></div>
              <div><dt>Liquidity</dt><dd>{formatMarketMetric(selected.liquidity)}/5</dd></div>
              <div><dt>Borrow rate</dt><dd>{selected.borrowRate === undefined ? selected.lendability ?? '—' : `${formatMarketMetric(selected.borrowRate)}%`}</dd></div>
              <div><dt>Volume</dt><dd>{compactMetric(selected.volume)}</dd></div>
              <div><dt>Market cap</dt><dd>{compactMetric(selected.marketCap, '$')}</dd></div>
            </dl>
            <div className="year-range">
              <span>52-week range</span>
              {selectedRangePosition === undefined || selected.yearLow === undefined || selected.yearHigh === undefined
                ? <strong>Range unavailable</strong>
                : (
                    <>
                      <div className="year-range-values">
                        <span>{priceFormatter.format(selected.yearLow)}</span>
                        <strong>{priceFormatter.format(selected.price)}</strong>
                        <span>{priceFormatter.format(selected.yearHigh)}</span>
                      </div>
                      <Progress aria-label={`${selected.symbol} is ${Math.round(selectedRangePosition)} percent through its 52-week range`} value={selectedRangePosition} />
                    </>
                  )}
            </div>
          </div>
        </CardFooter>
      </Card>

      <section className="watch-table premium-table" aria-labelledby="watch-title">
        <header className="section-header">
          <h2 className="watchlist-title" id="watch-title">{activeWatchlist.name}</h2>
          <div className="watch-search">
            <Search aria-hidden="true" />
            <input
              aria-label="Search all symbols"
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
            {watchTickers.map((ticker) => {
              const catalyst = nextCatalystForSymbol(ticker.symbol, catalysts, now)
              const verdict = volatilityVerdict(ticker)
              const copy = verdictCopy[verdict]
              const isPinned = pinned.has(ticker.symbol)
              const rangePosition = fiftyTwoWeekPosition(ticker)
              const type = assetLabel(ticker)
              return (
                <TableRow data-state={ticker.symbol === selected.symbol ? 'selected' : undefined} key={ticker.symbol}>
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
                      aria-label={`${ticker.symbol}, ${ticker.name}, ${ticker.position ? 'held, ' : ''}${copy.label} option premium, IV rank ${formatMarketMetric(ticker.ivRank)}`}
                      aria-pressed={ticker.symbol === selected.symbol}
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
                  <TableCell className="trend-cell">
                    <Sparkline points={ticker.sparkline} />
                    <small>{formatSignedMetric(ticker.changePercent, '%')}</small>
                  </TableCell>
                  <TableCell className={`premium-cell ${verdict}`}>
                    <strong>{copy.label}</strong>
                    <small>{formatMarketMetric(ticker.ivIndex)}% IV</small>
                    <small>{formatSignedMetric(ticker.ivIndex5DayChange, ' pts 5d')}</small>
                  </TableCell>
                  <TableCell className="rank-cell">
                    <strong>{formatMarketMetric(ticker.ivRank)}</strong>
                    <small>{formatMarketMetric(ticker.ivPercentile)} pct</small>
                  </TableCell>
                  <TableCell className="liquidity-cell">
                    <strong>{formatMarketMetric(ticker.liquidity)}/5</strong>
                    <small>{borrowLabel(ticker)}</small>
                  </TableCell>
                  <TableCell className="activity-cell">
                    <strong>{compactMetric(dollarVolume(ticker), '$', ' traded')}</strong>
                    <small>{compactMetric(ticker.marketCap, '$', ' cap')}</small>
                  </TableCell>
                  <TableCell className="range-cell">
                    <strong>{priceFormatter.format(ticker.price)}</strong>
                    <small>{rangePosition === undefined ? '—' : `${Math.round(rangePosition)}% of range`}</small>
                  </TableCell>
                </TableRow>
              )
            })}
            {!watchTickers.length && (
              <TableRow>
                <TableCell colSpan={8}>
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
