import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import {
  catalystLabel,
  nextCatalystsBySymbol,
  type Catalyst,
} from '../domain/catalyst'
import { volatilityVerdict, type Ticker } from '../domain/market'

/**
 * This rail receives only a neutral visible universe; it never sees source watchlist categories.
 * It is drawn only once something is pinned, so its empty state speaks to pins, not their absence.
 */
export function CatalystStories({
  catalysts,
  now,
  onSelect,
  tickers,
}: {
  catalysts: readonly Catalyst[]
  now: Date
  onSelect: (symbol: string) => void
  tickers: readonly Ticker[]
}) {
  const nextCatalysts = nextCatalystsBySymbol(catalysts, now)
  const visible = tickers
    .flatMap((ticker) => {
      const catalyst = nextCatalysts.get(ticker.symbol)
      return catalyst ? [{ catalyst, ticker }] : []
    })
    .sort((left, right) => left.catalyst.date.localeCompare(right.catalyst.date)
      || left.ticker.symbol.localeCompare(right.ticker.symbol))

  return (
    <section className="stories" aria-label="Upcoming catalysts">
      <div className="story-row">
        {visible.map(({ catalyst, ticker }) => (
          <Button
            aria-label={`${ticker.symbol}: ${catalyst.title}, ${catalyst.date}, ${catalyst.confidence}`}
            className={`story ${volatilityVerdict(ticker)}`}
            key={ticker.symbol}
            onClick={() => onSelect(ticker.symbol)}
            type="button"
            variant="ghost"
          >
            <span className="story-symbol">{ticker.symbol}</span>
            <Badge className={`story-catalyst ${catalyst.confidence}`} variant="outline">
              {catalystLabel(catalyst, now)}
            </Badge>
          </Button>
        ))}
        {!visible.length && (
          <Empty className="story-empty">
            <EmptyHeader>
              <EmptyDescription>
                No pinned catalysts are scheduled.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </section>
  )
}
