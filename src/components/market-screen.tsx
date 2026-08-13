import { ArrowDownRight, ArrowUpRight, ChevronDown } from 'lucide-react'

import { catalystLabel, nextCatalystForSymbol, sortSymbolsByCatalyst, upcomingInterestedSymbols, type Catalyst } from '../domain/catalyst'
import { volatilityVerdict, type Ticker, type Watchlist } from '../domain/market'
import { LiquidityMetric, MetricGauge, Sparkline } from './market-visuals'

function CatalystStories({
  catalysts,
  onSelect,
  tickers,
  watchlists,
}: {
  catalysts: Catalyst[]
  onSelect: (symbol: string) => void
  tickers: Ticker[]
  watchlists: Watchlist[]
}) {
  const positionSymbols = watchlists.find((watchlist) => watchlist.kind === 'positions')?.symbols ?? []
  const privateSymbols = watchlists
    .filter((watchlist) => watchlist.kind === 'private')
    .flatMap((watchlist) => watchlist.symbols)
  const visible = upcomingInterestedSymbols(positionSymbols, privateSymbols, catalysts)
    .map((symbol) => tickers.find((ticker) => ticker.symbol === symbol))
    .filter((ticker): ticker is Ticker => Boolean(ticker))
  return (
    <section className="stories" aria-labelledby="catalyst-stories-title">
      <header className="stories-title">
        <h2 id="catalyst-stories-title">Upcoming catalysts</h2>
        <span>30 days</span>
      </header>
      <div className="story-row">
        {visible.map((ticker) => {
          const catalyst = nextCatalystForSymbol(ticker.symbol, catalysts)
          return (
            <button
              className="story"
              key={ticker.symbol}
              onClick={() => onSelect(ticker.symbol)}
              title={catalyst ? `${catalyst.title} · ${catalyst.date} · ${catalyst.confidence}` : undefined}
              type="button"
            >
              <span className={`story-ring ${volatilityVerdict(ticker)}`}><span>{ticker.symbol.slice(0, 2)}</span></span>
              <span className="story-symbol">{ticker.symbol}</span>
              {catalyst && <span className={`story-catalyst ${catalyst.confidence}`}>{catalystLabel(catalyst)}</span>}
            </button>
          )
        })}
        {!visible.length && <p className="story-empty">Nothing scheduled in the next 30 days.</p>}
      </div>
    </section>
  )
}

export function MarketScreen({
  activeWatchlist,
  catalysts,
  onOpenPicker,
  onSelectTicker,
  selected,
  tickers,
  watchlists,
}: {
  activeWatchlist: Watchlist
  catalysts: Catalyst[]
  onOpenPicker: () => void
  onSelectTicker: (symbol: string) => void
  selected: Ticker
  tickers: Ticker[]
  watchlists: Watchlist[]
}) {
  const watchTickers = sortSymbolsByCatalyst(activeWatchlist.symbols, catalysts)
    .map((symbol) => tickers.find((ticker) => ticker.symbol === symbol))
    .filter((ticker): ticker is Ticker => Boolean(ticker))
  return (
    <>
      <CatalystStories catalysts={catalysts} onSelect={onSelectTicker} tickers={tickers} watchlists={watchlists} />
      <section className="ticker-hero">
        <div className="ticker-identity">
          <button className="ticker-switcher" onClick={onOpenPicker} type="button">
            <span>{selected.symbol}</span><ChevronDown size={19} aria-hidden="true" />
          </button>
          <p>{selected.name}</p>
        </div>
        <div className="price-line">
          <strong>${selected.price.toFixed(2)}</strong>
          <span className={selected.change >= 0 ? 'positive' : 'negative'}>
            {selected.change >= 0 ? <ArrowUpRight size={17} /> : <ArrowDownRight size={17} />}
            {selected.change >= 0 ? '+' : ''}{selected.change.toFixed(2)} ({selected.changePercent.toFixed(2)}%)
          </span>
        </div>
        <Sparkline ticker={selected} large />
        <div className="chart-periods" aria-label="Chart period">
          <button className="active" type="button">1D</button><button disabled type="button">1W</button>
          <button disabled type="button">1M</button><button disabled type="button">3M</button><button disabled type="button">1Y</button>
        </div>
      </section>

      <section className="options-section" aria-labelledby="options-title">
        <h2 className="sr-only" id="options-title">Options metrics</h2>
        <div className="metric-grid">
          <MetricGauge label="IV rank" value={selected.ivRank} hint="Position inside its 52-week range" />
          <MetricGauge label="IV index" value={selected.ivIndex} suffix="%" hint="Current annualized implied volatility" />
          <LiquidityMetric ticker={selected} />
          <MetricGauge label="IV percentile" value={selected.ivPercentile} hint="Share of sessions below current IV" />
        </div>
      </section>

      <section className="watch-table" aria-labelledby="watch-title">
        <header className="section-header">
          <h2 id="watch-title">{activeWatchlist.name}</h2>
          <button className="text-button" onClick={onOpenPicker} type="button">Change</button>
        </header>
        <div className="watch-rows">
          {watchTickers.map((ticker) => {
            const catalyst = nextCatalystForSymbol(ticker.symbol, catalysts)
            return (
              <button className={ticker.symbol === selected.symbol ? 'watch-row selected' : 'watch-row'} key={ticker.symbol} onClick={() => onSelectTicker(ticker.symbol)} type="button">
                <span className="symbol-cell"><strong>{ticker.symbol}</strong><small>{catalyst ? catalystLabel(catalyst) : volatilityVerdict(ticker) === 'rich' ? 'Hot vol' : volatilityVerdict(ticker) === 'cheap' ? 'Cool vol' : 'Mid vol'}</small></span>
                <Sparkline ticker={ticker} />
                <span className="quote-cell"><strong>${ticker.price.toFixed(2)}</strong><small className={ticker.change >= 0 ? 'positive' : 'negative'}>{ticker.change >= 0 ? '+' : ''}{ticker.changePercent.toFixed(2)}%</small></span>
              </button>
            )
          })}
        </div>
      </section>
    </>
  )
}
