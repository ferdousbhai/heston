import { ArrowDownRight, ArrowUpRight, ChevronDown, Settings2 } from 'lucide-react'

import { catalystLabel, nextCatalystForSymbol, sortSymbolsByCatalyst, upcomingInterestedSymbols, type Catalyst } from '../domain/catalyst'
import { volatilityVerdict, type Ticker, type Watchlist } from '../domain/market'
import { LiquidityMetric, MetricGauge, Sparkline } from './market-visuals'

function CatalystStories({
  catalysts,
  now,
  onSelect,
  tickers,
  watchlists,
}: {
  catalysts: Catalyst[]
  now: Date
  onSelect: (symbol: string) => void
  tickers: Ticker[]
  watchlists: Watchlist[]
}) {
  const positionSymbols = watchlists.find((watchlist) => watchlist.kind === 'positions')?.symbols ?? []
  const privateSymbols = watchlists
    .filter((watchlist) => watchlist.kind === 'private')
    .flatMap((watchlist) => watchlist.symbols)
  const visible = upcomingInterestedSymbols(positionSymbols, privateSymbols, catalysts, now)
    .map((symbol) => tickers.find((ticker) => ticker.symbol === symbol))
    .filter((ticker): ticker is Ticker => Boolean(ticker))
  return (
    <section className="stories" aria-label="Upcoming catalysts">
      <div className="story-row">
        {visible.map((ticker) => {
          const catalyst = nextCatalystForSymbol(ticker.symbol, catalysts, now)
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
              {catalyst && <span className={`story-catalyst ${catalyst.confidence}`}>{catalystLabel(catalyst, now)}</span>}
            </button>
          )
        })}
        {!visible.length && <p className="story-empty">Nothing scheduled.</p>}
      </div>
    </section>
  )
}

export function MarketScreen({
  activeWatchlist,
  catalysts,
  onManageWatchlist,
  onOpenPicker,
  onSelectWatchlist,
  onSelectTicker,
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
  selected: Ticker
  tickers: Ticker[]
  watchlists: Watchlist[]
}) {
  const now = new Date()
  const watchTickers = sortSymbolsByCatalyst(activeWatchlist.symbols, catalysts, now)
    .map((symbol) => tickers.find((ticker) => ticker.symbol === symbol))
    .filter((ticker): ticker is Ticker => Boolean(ticker))
  const selectableWatchlists = [
    ...watchlists.filter((watchlist) => watchlist.kind === 'positions'),
    ...watchlists.filter((watchlist) => watchlist.kind === 'private'),
    ...watchlists.filter((watchlist) => watchlist.kind === 'public'),
  ]
  return (
    <>
      <CatalystStories catalysts={catalysts} now={now} onSelect={onSelectTicker} tickers={tickers} watchlists={watchlists} />
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
          <h2 className="sr-only" id="watch-title">Watchlist</h2>
          <label className="watchlist-selector">
            <span className="sr-only">Choose watchlist</span>
            <select
              aria-labelledby="watch-title"
              onChange={(event) => {
                const watchlist = selectableWatchlists.find((candidate) => candidate.id === event.target.value)
                if (watchlist) onSelectWatchlist(watchlist)
              }}
              value={activeWatchlist.id}
            >
              {selectableWatchlists.map((watchlist) => <option key={watchlist.id} value={watchlist.id}>{watchlist.name}</option>)}
            </select>
            <ChevronDown aria-hidden="true" size={19} />
          </label>
          {activeWatchlist.kind === 'private' && (
            <button className="watchlist-manage-button" onClick={onManageWatchlist} type="button" aria-label={`Manage ${activeWatchlist.name}`}>
              <Settings2 aria-hidden="true" size={17} />
            </button>
          )}
        </header>
        <div className="watch-rows">
          {watchTickers.map((ticker) => {
            const catalyst = nextCatalystForSymbol(ticker.symbol, catalysts, now)
            const volatility = volatilityVerdict(ticker)
            return (
              <button aria-pressed={ticker.symbol === selected.symbol} className={ticker.symbol === selected.symbol ? 'watch-row selected' : 'watch-row'} key={ticker.symbol} onClick={() => onSelectTicker(ticker.symbol)} type="button">
                <span className="symbol-cell"><strong>{ticker.symbol}</strong><small>{catalyst ? catalystLabel(catalyst, now) : volatility === 'rich' ? 'Hot vol' : volatility === 'cheap' ? 'Cool vol' : 'Mid vol'}</small></span>
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
