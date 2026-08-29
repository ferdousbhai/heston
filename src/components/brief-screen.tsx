import { ArrowUpRight, ShieldCheck } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '#/components/ui/card'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '#/components/ui/collapsible'
import { Separator } from '#/components/ui/separator'
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
      <section className="ideas-section" aria-labelledby="ideas-title">
        {brief.readingList.length > 0 && (
          <section className="reading-section" aria-labelledby="reading-title">
            <header className="ideas-heading">
              <h2 id="reading-title">Links worth reading</h2>
              <span>{brief.readingList.length} selected</span>
            </header>
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
        <header className="ideas-heading">
          <h2 id="ideas-title">Ideas</h2>
          <span>{brief.ideas.length ? `${brief.ideas.length} today` : 'None today'}</span>
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
