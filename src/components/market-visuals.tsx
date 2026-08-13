import { type Ticker } from '../domain/market'

export function Sparkline({ ticker, large = false }: { large?: boolean; ticker: Ticker }) {
  const width = large ? 700 : 112
  const height = large ? 230 : 42
  const min = Math.min(...ticker.sparkline)
  const max = Math.max(...ticker.sparkline)
  const range = Math.max(max - min, 0.01)
  const points = ticker.sparkline.map((value, index) => {
    const x = (index / (ticker.sparkline.length - 1)) * width
    const y = height - ((value - min) / range) * (height * 0.78) - height * 0.1
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const positive = ticker.change >= 0
  const id = `fill-${ticker.symbol}-${large ? 'large' : 'small'}`
  return (
    <svg
      className={large ? 'price-chart' : 'sparkline'}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${ticker.symbol} intraday price chart, ${positive ? 'up' : 'down'} ${Math.abs(ticker.changePercent).toFixed(2)} percent`}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={positive ? '#c8ff62' : '#ff6b78'} stopOpacity=".28" />
          <stop offset="1" stopColor={positive ? '#c8ff62' : '#ff6b78'} stopOpacity="0" />
        </linearGradient>
      </defs>
      {large && <path d={`M ${points} L ${width},${height} L 0,${height} Z`} fill={`url(#${id})`} />}
      <polyline
        points={points}
        fill="none"
        stroke={positive ? '#c8ff62' : '#ff6b78'}
        strokeWidth={large ? 4 : 2.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

export function MetricGauge({ label, value, suffix = '', hint }: { hint: string; label: string; suffix?: string; value: number }) {
  const bounded = Math.max(0, Math.min(100, value))
  return (
    <article className="metric-item">
      <div className="metric-heading">{label}</div>
      <div className="metric-value">{Number.isInteger(value) ? value : value.toFixed(1)}{suffix}</div>
      <div className="gauge-track" aria-hidden="true"><span style={{ width: `${bounded}%` }} /></div>
      <p>{hint}</p>
    </article>
  )
}

export function LiquidityMetric({ ticker }: { ticker: Ticker }) {
  return (
    <article className="metric-item">
      <div className="metric-heading">Liquidity</div>
      <div className="metric-value">{ticker.liquidity}<small>/5</small></div>
      <div className="liquidity-dots" aria-label={`${ticker.liquidity} out of 5 liquidity`}>
        {[1, 2, 3, 4, 5].map((value) => <i className={value <= ticker.liquidity ? 'filled' : ''} key={value} />)}
      </div>
      <p>Broker liquidity score</p>
    </article>
  )
}
