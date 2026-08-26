import { ChevronDown, Settings2 } from 'lucide-react'

import { Badge } from '#/components/ui/badge'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '#/components/ui/tooltip'
import { cn } from '#/lib/utils'
import { catalystLabel, nextCatalystForSymbol, type Catalyst } from '../domain/catalyst'
import {
  formatMarketMetric,
  volatilityVerdict,
  type Ticker,
  type VolatilityVerdict,
  type Watchlist,
} from '../domain/market'
import { CatalystStories } from './catalyst-stories'

const verdictCopy = {
  cheap: { detail: 'Low versus its own year', label: 'Cheap' },
  fair: { detail: 'Near its usual range', label: 'Fair' },
  rich: { detail: 'High versus its own year', label: 'Expensive' },
} satisfies Record<VolatilityVerdict, { detail: string; label: string }>

function premiumScore(ticker: Pick<Ticker, 'ivRank' | 'ivPercentile'>): number {
  return Math.round((ticker.ivRank + ticker.ivPercentile) / 2)
}

function intentLabel(ticker: Ticker, showAccountIntent: boolean): string {
  if (!showAccountIntent) return 'Public watch'
  return ticker.position ? 'Open position' : 'Entry watch'
}

export function MarketScreen({
  activeWatchlist,
  catalysts,
  onManageWatchlist,
  onOpenPicker,
  onSelectWatchlist,
  onSelectTicker,
  selected,
  showAccountIntent,
  tickers,
  watchlists,
}: {
  activeWatchlist: Watchlist
  catalysts: Catalyst[]
  onManageWatchlist: () => void
  onOpenPicker: () => void
  onSelectWatchlist: (watchlist: Watchlist) => void
  onSelectTicker: (symbol: string) => void
  selected: Ticker
  showAccountIntent: boolean
  tickers: Ticker[]
  watchlists: Watchlist[]
}) {
  const now = new Date()
  const watchTickers = activeWatchlist.symbols
    .map((symbol, index) => ({ index, ticker: tickers.find((candidate) => candidate.symbol === symbol) }))
    .filter((item): item is { index: number; ticker: Ticker } => Boolean(item.ticker))
    .sort((left, right) => Number(right.ticker.position) - Number(left.ticker.position) || left.index - right.index)
    .map((item) => item.ticker)
  const selectableWatchlists = [
    ...watchlists.filter((watchlist) => watchlist.kind === 'private'),
    ...watchlists.filter((watchlist) => watchlist.kind === 'positions'),
    ...watchlists.filter((watchlist) => watchlist.kind === 'public'),
  ]
  const selectedVerdict = volatilityVerdict(selected)
  const selectedCopy = verdictCopy[selectedVerdict]
  const watchlistOptions = selectableWatchlists.map((watchlist) => ({ label: watchlist.name, value: watchlist.id }))

  return (
    <div className="market-screen">
      <section className="market-intro" aria-labelledby="market-title">
        <p className="market-kicker"><span aria-hidden="true" />Tastytrade · {showAccountIntent ? 'private account' : 'public read'}</p>
        <h1 id="market-title">Option premium</h1>
        <p>Relative cost, not price direction. IV rank and percentile compare each name with its own recent history.</p>
      </section>

      <CatalystStories catalysts={catalysts} now={now} onSelect={onSelectTicker} tickers={tickers} />

      <Card className={cn('premium-focus', selectedVerdict)} variant="flat" aria-labelledby="selected-premium-title">
        <CardHeader>
          <Button className="ticker-switcher" onClick={onOpenPicker} size="ticker" type="button" variant="ghost">
            <span>{selected.symbol}</span><ChevronDown aria-hidden="true" data-icon="inline-end" />
          </Button>
          <Badge className="intent-label" variant="outline">{intentLabel(selected, showAccountIntent)}</Badge>
        </CardHeader>
        <CardContent>
          <div className="premium-focus-copy">
            <div>
              <span id="selected-premium-title">Premium looks</span>
              <strong>{selectedCopy.label}</strong>
            </div>
            <p>{selectedCopy.detail}. Last ${selected.price.toFixed(2)}.</p>
          </div>
          <div className="premium-axis-labels" aria-hidden="true">
            <span>Cheap</span><span>Fair</span><span>Expensive</span>
          </div>
          <Progress className="premium-axis" aria-label={`Relative premium score ${premiumScore(selected)} out of 100`} value={premiumScore(selected)} />
        </CardContent>
        <CardFooter>
          <dl className="premium-stats">
            <div><dt>IV rank</dt><dd>{formatMarketMetric(selected.ivRank)}</dd></div>
            <div><dt>IV percentile</dt><dd>{formatMarketMetric(selected.ivPercentile)}</dd></div>
            <div><dt>Implied vol</dt><dd>{formatMarketMetric(selected.ivIndex)}%</dd></div>
            <div><dt>Liquidity</dt><dd>{formatMarketMetric(selected.liquidity)}/5</dd></div>
          </dl>
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
        <div className="premium-table-heading" aria-hidden="true">
          <span>Name</span><span>Relative cost</span><span>IV rank</span>
        </div>
        <div className="watch-rows">
          {watchTickers.map((ticker) => {
            const catalyst = nextCatalystForSymbol(ticker.symbol, catalysts, now)
            const verdict = volatilityVerdict(ticker)
            const copy = verdictCopy[verdict]
            return (
              <Button
                aria-label={`${ticker.symbol}, ${intentLabel(ticker, showAccountIntent)}, ${copy.label} option premium, IV rank ${formatMarketMetric(ticker.ivRank)}`}
                aria-pressed={ticker.symbol === selected.symbol}
                className={cn('watch-row', ticker.symbol === selected.symbol && 'selected')}
                key={ticker.symbol}
                onClick={() => onSelectTicker(ticker.symbol)}
                type="button"
                variant="ghost"
              >
                <span className="symbol-cell">
                  <span><strong>{ticker.symbol}</strong><Badge variant="secondary">{showAccountIntent ? ticker.position ? 'Position' : 'Watching' : 'Public'}</Badge></span>
                  <small>{catalyst ? catalystLabel(catalyst, now) : ticker.name}</small>
                </span>
                <span className={`premium-cell ${verdict}`}>
                  <Badge variant={verdict}>{copy.label}</Badge><small>{formatMarketMetric(ticker.ivIndex)}% IV</small>
                </span>
                <span className="rank-cell"><strong>{formatMarketMetric(ticker.ivRank)}</strong><small>{formatMarketMetric(ticker.ivPercentile)} pct</small></span>
              </Button>
            )
          })}
          {!watchTickers.length && (
            <Empty className="watch-empty">
              <EmptyHeader><EmptyDescription>No option metrics are available for this list.</EmptyDescription></EmptyHeader>
            </Empty>
          )}
        </div>
      </section>
    </div>
  )
}
