import { ArrowUpRight, ShieldCheck } from 'lucide-react'

import { type ResearchBrief } from '../domain/market'

export function BriefScreen({ brief, onSymbol }: { brief: ResearchBrief; onSymbol: (symbol: string) => void }) {
  return (
    <div className="brief-screen">
      <section className="brief-cover">
        <span className="brief-issue">SPICE · {new Date(brief.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()}</span>
        <h1>{brief.title}</h1>
        <p>{brief.summary}</p>
        <div className="regime-summary"><span>Current regime</span><strong>{brief.regime}</strong><small>{brief.regimeDetail}</small></div>
      </section>
      <section className="ideas-section" aria-labelledby="ideas-title">
        <h2 className="sr-only" id="ideas-title">Trade ideas</h2>
        <div className="idea-stack">
          {brief.ideas.map((idea) => (
            <article className="idea-card" key={`${idea.symbol}-${idea.setup}`}>
              <div className="idea-top"><button onClick={() => onSymbol(idea.symbol)} type="button">{idea.symbol}<ArrowUpRight size={16} /></button><span className={`direction-${idea.direction}`}>{idea.direction}</span></div>
              <h3>{idea.setup}</h3><span className="horizon">{idea.horizon}</span>
              <p>{idea.thesis}</p>
              <div className="risk-line"><ShieldCheck size={16} aria-hidden="true" /><span><strong>What breaks it</strong>{idea.risk}</span></div>
            </article>
          ))}
        </div>
        {brief.sources.length > 0 && (
          <details className="source-list">
            <summary><span>Sources</span><small>{brief.sources.length}</small></summary>
            <div className="source-links">
              {brief.sources.map((source) => (
                <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
                  <span>{source.label}</span><ArrowUpRight size={14} aria-hidden="true" />
                </a>
              ))}
            </div>
          </details>
        )}
        <p className="disclaimer">Research context only, not investment advice. Options involve risk and can lose their full value.</p>
      </section>
    </div>
  )
}
