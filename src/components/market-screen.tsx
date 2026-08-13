import { ArrowDownRight, ArrowUpRight, ChevronDown, Flame, Search } from 'lucide-react'

import { optionsTemperatureCopy, volatilityVerdict, type Ticker, type Watchlist } from '../domain/market'
import { LiquidityMetric, MetricGauge, Sparkline, VerdictPill } from './market-visuals'

function WatchlistStrip({
  active,
  onOpen,
  onSelect,
  tickers,
}: {
  active: Watchlist
  onOpen: () => void
  onSelect: (symbol: string) => void
  tickers: Ticker[]
}) {
  const visible = active.symbols
    .map((symbol) => tickers.find((ticker) => ticker.symbol === symbol))
    .filter((ticker): ticker is Ticker => Boolean(ticker))
  return (
    <section className="stories" aria-label={`${active.name} symbols`}>
      <button className="watchlist-title" onClick={onOpen} type="button">
        <span>{active.name}</span><ChevronDown size={17} aria-hidden="true" />
      </button>
      <div className="story-row">
        {visible.map((ticker) => (
          <button className="story" key={ticker.symbol} onClick={() => onSelect(ticker.symbol)} type="button">
            <span className={`story-ring ${volatilityVerdict(ticker)}`}><span>{ticker.symbol.slice(0, 2)}</span></span>
            <span className="story-symbol">{ticker.symbol}</span>
          </button>
        ))}
        <button className="story" onClick={onOpen} type="button">
          <span className="story-ring more"><Search size={18} aria-hidden="true" /></span>
          <span className="story-symbol">Browse</span>
        </button>
      </div>
    </section>
  )
}

export function MarketScreen({
  activeWatchlist,
  onAskDan,
  onOpenPicker,
  onSelectTicker,
  selected,
  tickers,
}: {
  activeWatchlist: Watchlist
  onAskDan: () => void
  onOpenPicker: () => void
  onSelectTicker: (symbol: string) => void
  selected: Ticker
  tickers: Ticker[]
}) {
  const temperature = optionsTemperatureCopy(selected)
  const watchTickers = activeWatchlist.symbols
    .map((symbol) => tickers.find((ticker) => ticker.symbol === symbol))
    .filter((ticker): ticker is Ticker => Boolean(ticker))
  return (
    <>
      <WatchlistStrip active={activeWatchlist} onOpen={onOpenPicker} onSelect={onSelectTicker} tickers={tickers} />
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
        <header className="section-header">
          <h2 id="options-title">Options premium</h2>
          <VerdictPill ticker={selected} />
        </header>
        <div className="metric-grid">
          <MetricGauge label="IV rank" value={selected.ivRank} hint="Position inside its 52-week range" />
          <MetricGauge label="IV index" value={selected.ivIndex} suffix="%" hint="Current annualized implied volatility" />
          <LiquidityMetric ticker={selected} />
          <MetricGauge label="IV percentile" value={selected.ivPercentile} hint="Share of sessions below current IV" />
        </div>
        <article className={`temperature-note ${volatilityVerdict(selected)}`}>
          <div><h3><Flame size={17} aria-hidden="true" />{temperature.title}</h3><p>{temperature.detail}</p></div>
          <button onClick={onAskDan} type="button">Ask Dan →</button>
        </article>
      </section>

      <section className="watch-table" aria-labelledby="watch-title">
        <header className="section-header">
          <h2 id="watch-title">{activeWatchlist.name}</h2>
          <button className="text-button" onClick={onOpenPicker} type="button">Change</button>
        </header>
        <div className="watch-rows">
          {watchTickers.map((ticker) => (
            <button className={ticker.symbol === selected.symbol ? 'watch-row selected' : 'watch-row'} key={ticker.symbol} onClick={() => onSelectTicker(ticker.symbol)} type="button">
              <span className="symbol-cell"><strong>{ticker.symbol}</strong><small>{volatilityVerdict(ticker) === 'rich' ? 'Hot vol' : volatilityVerdict(ticker) === 'cheap' ? 'Cool vol' : 'Mid vol'}</small></span>
              <Sparkline ticker={ticker} />
              <span className="quote-cell"><strong>${ticker.price.toFixed(2)}</strong><small className={ticker.change >= 0 ? 'positive' : 'negative'}>{ticker.change >= 0 ? '+' : ''}{ticker.changePercent.toFixed(2)}%</small></span>
            </button>
          ))}
        </div>
      </section>
    </>
  )
}
