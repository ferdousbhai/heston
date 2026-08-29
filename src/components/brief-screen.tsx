import { ArrowUpRight, ShieldCheck } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#/components/ui/card'
import { type ResearchBrief } from '../domain/market'

const issueDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

export function BriefScreen({
  availableSymbols,
  brief,
  onSymbol,
}: {
  availableSymbols: ReadonlySet<string>
  brief: ResearchBrief
  onSymbol: (symbol: string) => void
}) {
  return (
    <div className="brief-screen">
      <header className="brief-cover">
        <time dateTime={brief.publishedAt}>{issueDate.format(new Date(brief.publishedAt))}</time>
        <h1>{brief.regime}</h1>
        <p>{brief.regimeDetail}</p>
        <p>{brief.summary}</p>
      </header>
      <div className="ideas-section">
        {brief.readingList.length > 0 && (
          <section aria-label="Sources" className="reading-section">
            <ol className="reading-list">
              {brief.readingList.map((item) => (
                <li key={item.url}>
                  <a href={item.url} rel="noreferrer" target="_blank">
                    <strong>{item.title}</strong><ArrowUpRight aria-hidden="true" />
                    <span>{item.reason}</span>
                  </a>
                </li>
              ))}
            </ol>
          </section>
        )}
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
              {idea.play && (
                <CardContent className="play-line">
                  <span>Potential play</span>
                  <strong>{idea.play}</strong>
                </CardContent>
              )}
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
        </div>
        <Alert className="disclaimer">
          <AlertTitle>Research context only, not investment advice</AlertTitle>
          <AlertDescription>Every contract is illustrative; verify the live chain, spread, and expiry before acting.</AlertDescription>
        </Alert>
      </div>
    </div>
  )
}
