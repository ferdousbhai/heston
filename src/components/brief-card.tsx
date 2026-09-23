import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { type BriefRecommendation } from '../domain/brief'
import { ThesisMarkdown } from './thesis-markdown'

/** One trade as the published brief carries it: the bold trade line, the direction, and the thesis. */
export function RecommendationCard({ onSymbol, recommendation }: { onSymbol?: (symbol: string) => void; recommendation: BriefRecommendation }) {
  return (
    <article className="brief-card">
      <header className="brief-card-head">
        <strong className="trade-line">{recommendation.trade}</strong>
        <Badge variant={recommendation.direction}>{recommendation.direction}</Badge>
        {onSymbol && (
          <Button onClick={() => onSymbol(recommendation.symbol)} size="sm" type="button" variant="link">
            {recommendation.symbol}
          </Button>
        )}
      </header>
      <ThesisMarkdown text={recommendation.thesis} />
    </article>
  )
}
