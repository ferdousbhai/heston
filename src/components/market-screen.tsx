import { ChevronDown, Settings2, Star } from 'lucide-react'

import { Button } from '#/components/ui/button'
import { Card, CardContent, CardFooter, CardHeader } from '#/components/ui/card'
import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import { Progress } from '#/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#/components/ui/select'
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

function compactMetric(value: number | undefined, prefix = ''): string {
  return value === undefined ? 'N/A' : `${prefix}${compactFormatter.format(value)}`
}

function formatSignedMetric(value: number | undefined, suffix = ''): string {
  if (value === undefined) return 'N/A'
  return `${value > 0 ? '+' : ''}${formatMarketMetric(value)}${suffix}`
}

function assetLabel(ticker: Pick<Ticker, 'assetType'>): string | undefined {
  return ticker.assetType === 'etf' ? 'ETF' : ticker.assetType === 'index' ? 'Index' : undefined
}

function borrowLabel(ticker: Pick<Ticker, 'borrowRate' | 'lendability'>): string {
  if (ticker.borrowRate !== undefined) return `${formatMarketMetric(ticker.borrowRate)}% borrow`
  return ticker.lendability ?? 'Borrow N/A'
}

function termStructureLabel(ticker: Pick<Ticker, 'ivTermStructure'>): string {
  const term = ticker.ivTermStructure
  if (!term) return 'N/A'
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
  onOpenPicker,
  onSelectWatchlist,
  onSelectTicker,
  onTogglePinned,
  pinnedSymbols,
  selected,
  tickers,
  watchlists,
}: {
  activeWatchlist: Watchlist
  catalysts: Catalyst[]
  onManageWatchlist: () => void
  onOpenPicker: () => void
  onSelectWatchlist: (watchlist: Watchlist) => void
  onSelectTicker: (symbol: string) => void
  onTogglePinned: (symbol: string) => void
  pinnedSymbols: readonly string[]
  selected: Ticker
  tickers: Ticker[]
  watchlists: Watchlist[]
}) {
  const now = new Date()
  const pinned = new Set(pinnedSymbols)
  const watchTickers = activeWatchlist.symbols
    .map((symbol, index) => ({ index, ticker: tickers.find((candidate) => candidate.symbol === symbol) }))
    .filter((item): item is { index: number; ticker: Ticker } => Boolean(item.ticker))
    .sort((left, right) => Number(pinned.has(right.ticker.symbol)) - Number(pinned.has(left.ticker.symbol))
      || Number(right.ticker.position) - Number(left.ticker.position)
      || left.index - right.index)
    .map((item) => item.ticker)
  const pinnedTickers = tickers.filter((ticker) => pinned.has(ticker.symbol))
  const selectableWatchlists = [
    ...watchlists.filter((watchlist) => watchlist.kind === 'private'),
    ...watchlists.filter((watchlist) => watchlist.kind === 'positions'),
    ...watchlists.filter((watchlist) => watchlist.kind === 'public'),
  ]
  const selectedVerdict = volatilityVerdict(selected)
  const selectedCopy = verdictCopy[selectedVerdict]
  const selectedAsset = assetLabel(selected)
  const selectedRangePosition = fiftyTwoWeekPosition(selected)
  const watchlistOptions = selectableWatchlists.map((watchlist) => ({ label: watchlist.name, value: watchlist.id }))

  return (
    <div className="market-screen">
      <CatalystStories catalysts={catalysts} now={now} onSelect={onSelectTicker} tickers={pinnedTickers} />

      <Card className={cn('premium-focus', selectedVerdict)} variant="flat" aria-labelledby="selected-premium-title">
        <CardHeader>
          <div className="selected-instrument">
            <Button className="ticker-switcher" onClick={onOpenPicker} size="ticker" type="button" variant="ghost">
              <span>{selected.symbol}</span><ChevronDown aria-hidden="true" data-icon="inline-end" />
            </Button>
            <p>{selected.name}{selectedAsset ? ` · ${selectedAsset}` : ''}</p>
          </div>
        </CardHeader>
        <CardContent>
          <strong className="premium-focus-verdict" id="selected-premium-title">{selectedCopy.label}</strong>
          <div className="premium-axis-labels" aria-hidden="true">
            <span>Cheap</span><span>Fair</span><span>Expensive</span>
          </div>
          <Progress className="premium-axis" aria-label={`Relative premium score ${premiumScore(selected)} out of 100`} value={premiumScore(selected)} />
        </CardContent>
        <CardFooter>
          <div className="premium-details">
            <dl className="premium-stats">
              <div><dt>Current IV</dt><dd>{formatMarketMetric(selected.ivIndex)}%</dd></div>
              <div><dt>IV rank</dt><dd>{formatMarketMetric(selected.ivRank)}</dd></div>
              <div><dt>IV percentile</dt><dd>{formatMarketMetric(selected.ivPercentile)}</dd></div>
              <div><dt>IV 5-day</dt><dd>{formatSignedMetric(selected.ivIndex5DayChange, ' pts')}</dd></div>
              <div><dt>30-day HV</dt><dd>{selected.historicalVolatility30Day === undefined ? 'N/A' : `${formatMarketMetric(selected.historicalVolatility30Day)}%`}</dd></div>
              <div><dt>IV minus HV</dt><dd>{formatSignedMetric(selected.ivHistoricalVolatility30DayDifference, ' pts')}</dd></div>
              <div><dt>Term structure</dt><dd>{termStructureLabel(selected)}</dd></div>
              <div><dt>Liquidity</dt><dd>{formatMarketMetric(selected.liquidity)}/5</dd></div>
              <div><dt>Borrow rate</dt><dd>{selected.borrowRate === undefined ? selected.lendability ?? 'N/A' : `${formatMarketMetric(selected.borrowRate)}%`}</dd></div>
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
          <Select
            items={watchlistOptions}
            onValueChange={(value) => {
              const watchlist = selectableWatchlists.find((candidate) => candidate.id === value)
              if (watchlist) onSelectWatchlist(watchlist)
            }}
            value={activeWatchlist.id}
          >
            <SelectTrigger aria-labelledby="watch-title" className="watchlist-selector">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false} side="bottom">
              <SelectGroup>
                {watchlistOptions.map((watchlist) => (
                  <SelectItem key={watchlist.value} value={watchlist.value}>{watchlist.label}</SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <h2 className="sr-only" id="watch-title">Watchlist</h2>
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
              <TableHead>Instrument</TableHead>
              <TableHead>Option premium</TableHead>
              <TableHead>IV rank</TableHead>
              <TableHead>Liquidity</TableHead>
              <TableHead>Activity</TableHead>
              <TableHead>52-week range</TableHead>
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
                      aria-label={`${ticker.symbol}, ${ticker.name}, ${copy.label} option premium, IV rank ${formatMarketMetric(ticker.ivRank)}`}
                      aria-pressed={ticker.symbol === selected.symbol}
                      className="ticker-table-button"
                      onClick={() => onSelectTicker(ticker.symbol)}
                      type="button"
                      variant="ghost"
                    >
                      <span><strong>{ticker.symbol}</strong>{type ? <small>{type}</small> : null}</span>
                      <small>{ticker.name}</small>
                      {catalyst ? <small>{catalystLabel(catalyst, now)}</small> : null}
                    </Button>
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
                    <strong>{compactMetric(ticker.volume)} vol</strong>
                    <small>{compactMetric(ticker.marketCap, '$')} cap</small>
                  </TableCell>
                  <TableCell className="range-cell">
                    <strong>{priceFormatter.format(ticker.price)}</strong>
                    <small>{rangePosition === undefined ? '52w N/A' : `${Math.round(rangePosition)}% of range`}</small>
                  </TableCell>
                </TableRow>
              )
            })}
            {!watchTickers.length && (
              <TableRow>
                <TableCell colSpan={7}>
                  <Empty className="watch-empty">
                    <EmptyHeader><EmptyDescription>No option metrics are available for this list.</EmptyDescription></EmptyHeader>
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
