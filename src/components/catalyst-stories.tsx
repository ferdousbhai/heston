import { Avatar, AvatarFallback } from '#/components/ui/avatar'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import {
  catalystLabel,
  nextCatalystForSymbol,
  upcomingCatalystSymbols,
  type Catalyst,
} from '../domain/catalyst'
import { volatilityVerdict, type Ticker } from '../domain/market'

/** This rail receives only a neutral visible universe; it never sees source watchlist categories. */
export function CatalystStories({
  catalysts,
  now = new Date(),
  onSelect,
  tickers,
}: {
  catalysts: readonly Catalyst[]
  now?: Date
  onSelect: (symbol: string) => void
  tickers: readonly Ticker[]
}) {
  const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.symbol, ticker]))
  const visible = upcomingCatalystSymbols(tickers.map((ticker) => ticker.symbol), catalysts, now)
    .flatMap((symbol) => {
      const ticker = tickerBySymbol.get(symbol)
      const catalyst = nextCatalystForSymbol(symbol, catalysts, now)
      return ticker && catalyst ? [{ catalyst, ticker }] : []
    })

  return (
    <section className="stories" aria-label="Upcoming catalysts">
      <div className="story-row">
        {visible.map(({ catalyst, ticker }) => (
          <Button
            aria-label={`${ticker.symbol}: ${catalyst.title}, ${catalyst.date}, ${catalyst.confidence}`}
            className="story"
            key={ticker.symbol}
            onClick={() => onSelect(ticker.symbol)}
            type="button"
            variant="ghost"
          >
            <span className={`story-ring ${volatilityVerdict(ticker)}`}>
              <Avatar className="story-avatar" size="lg">
                <AvatarFallback>{ticker.symbol.slice(0, 2)}</AvatarFallback>
              </Avatar>
            </span>
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
                {tickers.length ? 'No pinned catalysts are scheduled in the next 30 days.' : 'Pin a ticker to see its upcoming events.'}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </section>
  )
}
