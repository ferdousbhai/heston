import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { type BriefRecommendation } from '../domain/brief'
import { ThesisMarkdown } from './thesis-markdown'

/** Every dated line on the site: New York time, since that is where the market day is. */
export const issueDate = new Intl.DateTimeFormat('en-US', {
  day: 'numeric', hour: 'numeric', minute: '2-digit', month: 'short', timeZone: 'America/New_York', timeZoneName: 'short', year: 'numeric',
})

/** One trade as the channel posted it: the bold trade line, the direction, and the thesis. */
export function RecommendationCard({ onSymbol, recommendation }: { onSymbol?: (symbol: string) => void; recommendation: BriefRecommendation }) {
  const badgeVariant = recommendation.direction === 'neutral' ? 'default' : recommendation.direction
  return (
    <article className="brief-card">
      <header className="brief-card-head">
        <strong className="trade-line">{recommendation.trade}</strong>
        <Badge variant={badgeVariant}>{recommendation.direction}</Badge>
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
