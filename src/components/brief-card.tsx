import { type BriefRecommendation } from '../domain/brief'
import { ThesisMarkdown } from './thesis-markdown'

/** One trade as the published brief carries it: the bold trade line and the thesis. */
export function RecommendationCard({ onSymbol, recommendation }: { onSymbol?: (symbol: string) => void; recommendation: BriefRecommendation }) {
  return (
    <article className="brief-card">
      <header className="brief-card-head">
        {/* The trade line is the way into the market for this name: it opens the symbol in Watch.
            Its visible text stays its accessible name, so a spoken command matches what is read. */}
        {onSymbol
          ? (
            <button className="trade-line trade-link" onClick={() => onSymbol(recommendation.symbol)} title={`Open ${recommendation.symbol} in Watch`} type="button">
              {recommendation.trade}
            </button>
          )
          : <strong className="trade-line">{recommendation.trade}</strong>}
      </header>
      <ThesisMarkdown text={recommendation.thesis} />
    </article>
  )
}
