import { ArrowUpRight, ShieldCheck } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#/components/ui/collapsible'
import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import { Separator } from '#/components/ui/separator'
import { type ResearchBrief } from '../domain/market'

const compactNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, notation: 'compact' })
const priceNumber = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })

function moverCategory(category: ResearchBrief['marketMovers'][number]['category']): string {
  if (category === 'most-active') return 'most active'
  return category
}

export function BriefScreen({
  availableSymbols,
  brief,
  onSymbol,
}: {
  availableSymbols: ReadonlySet<string>
  brief: ResearchBrief
  onSymbol: (symbol: string) => void
}) {
  const issueDate = new Date(brief.publishedAt).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })
  return (
    <div className="brief-screen">
      <header className="brief-cover">
        <div className="brief-issue"><span>Daily read</span><time dateTime={brief.publishedAt}>{issueDate}</time></div>
        <h1>{brief.title}</h1>
        <p>{brief.summary}</p>
        <div className="regime-summary">
          <span>Options backdrop</span><strong>{brief.regime}</strong><small>{brief.regimeDetail}</small>
        </div>
      </header>
      <section className="ideas-section" aria-labelledby="ideas-title">
        {brief.marketMovers.length > 0 && (
          <section className="movers-section" aria-labelledby="movers-title">
            <header className="ideas-heading">
              <h2 id="movers-title">Moves investigated</h2>
              <span>{brief.marketMovers.length} ticker{brief.marketMovers.length === 1 ? '' : 's'}</span>
            </header>
            <div className="mover-stack">
              {brief.marketMovers.map((mover) => (
                <Card className="mover-card" key={mover.symbol} variant="flat">
                  <CardHeader className="mover-top">
                    {availableSymbols.has(mover.symbol)
                      ? (
                          <Button onClick={() => onSymbol(mover.symbol)} type="button" variant="link">
                            {mover.symbol}<ArrowUpRight data-icon="inline-end" />
                          </Button>
                        )
                      : <strong className="mover-symbol">{mover.symbol}</strong>}
                    <Badge variant={mover.changePercent >= 0 ? 'bullish' : 'bearish'}>
                      {mover.changePercent >= 0 ? '+' : ''}{mover.changePercent.toFixed(2)}%
                    </Badge>
                    <CardTitle>{mover.headline}</CardTitle>
                    <CardDescription>{mover.description}</CardDescription>
                  </CardHeader>
                  <CardContent className="mover-metrics">
                    <span>${priceNumber.format(mover.price)}</span>
                    <span>{compactNumber.format(mover.volume)} volume</span>
                    <span>{moverCategory(mover.category)}</span>
                  </CardContent>
                  <CardFooter className="mover-sources">
                    {mover.sources.map((source) => (
                      <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
                        {source.label}<ArrowUpRight aria-hidden="true" />
                      </a>
                    ))}
                  </CardFooter>
                </Card>
              ))}
            </div>
          </section>
        )}
        <header className="ideas-heading">
          <h2 id="ideas-title">Worth your attention</h2>
          <span>{brief.ideas.length || 'No'} signal{brief.ideas.length === 1 ? '' : 's'}</span>
        </header>
        <div className="idea-stack">
          {brief.ideas.map((idea) => (
            <Card className="idea-card" key={`${idea.symbol}-${idea.headline}`} variant="flat">
              <CardHeader className="idea-top">
                {availableSymbols.has(idea.symbol)
                  ? (
                      <Button onClick={() => onSymbol(idea.symbol)} size="lg" type="button" variant="link">
                        {idea.symbol}<ArrowUpRight data-icon="inline-end" />
                      </Button>
                    )
                  : <strong className="idea-symbol">{idea.symbol}</strong>}
                <Badge variant={idea.direction}>{idea.direction}</Badge>
                <CardTitle>{idea.headline}</CardTitle>
                <CardDescription>{idea.description}</CardDescription>
              </CardHeader>
              <CardContent className="play-line">
                <span>Potential play</span>
                <strong>{idea.play ?? 'Fresh structure pending'}</strong>
              </CardContent>
              <CardFooter className="risk-line">
                <Alert>
                  <ShieldCheck aria-hidden="true" />
                  <AlertTitle>What breaks it</AlertTitle>
                  <AlertDescription>{idea.risk}</AlertDescription>
                </Alert>
              </CardFooter>
              {idea.sources.length > 0 && (
                <CardFooter className="idea-sources">
                  {idea.sources.map((source) => (
                    <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
                      {source.label}<ArrowUpRight aria-hidden="true" />
                    </a>
                  ))}
                </CardFooter>
              )}
            </Card>
          ))}
          {!brief.ideas.length && (
            <Empty className="ideas-empty">
              <EmptyHeader><EmptyDescription>The filter found no thesis strong enough to surface today.</EmptyDescription></EmptyHeader>
            </Empty>
          )}
        </div>
        {brief.sources.length > 0 && (
          <Collapsible className="source-list">
            <CollapsibleTrigger render={<Button className="source-list-trigger" type="button" variant="ghost" />}>
              <span>Evidence reviewed</span><Badge variant="secondary">{brief.sources.length}</Badge>
            </CollapsibleTrigger>
            <CollapsibleContent className="source-links">
              <Separator />
              {brief.sources.map((source) => (
                <a href={source.url} key={`${source.url}-${source.label}`} rel="noreferrer" target="_blank">
                  <span>{source.label}</span><ArrowUpRight aria-hidden="true" />
                </a>
              ))}
            </CollapsibleContent>
          </Collapsible>
        )}
        <Alert className="disclaimer">
          <AlertTitle>Research context only, not investment advice</AlertTitle>
          <AlertDescription>Every contract is illustrative; verify the live chain, spread, and expiry before acting.</AlertDescription>
        </Alert>
      </section>
    </div>
  )
}
