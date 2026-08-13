import { ArrowUpRight, ShieldCheck } from 'lucide-react'

import { type ResearchBrief } from '../domain/market'

export function BriefScreen({ brief, onSymbol }: { brief: ResearchBrief; onSymbol: (symbol: string) => void }) {
  return (
    <div className="brief-screen">
      <section className="brief-cover">
        <div className="brief-orb" aria-hidden="true" />
        <span className="brief-issue">THE SPICE MUST FLOW · {new Date(brief.publishedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()}</span>
        <h1>{brief.title}</h1>
        <p>{brief.summary}</p>
        <div className="regime-summary"><span>Current regime</span><strong>{brief.regime}</strong><small>{brief.regimeDetail}</small></div>
      </section>
      <section className="ideas-section">
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
          <div className="source-list">
            <span className="source-label">Sources</span>
            {brief.sources.map((source) => (
              <a href={source.url} key={source.url} rel="noreferrer" target="_blank">
                <span>{source.label}</span><ArrowUpRight size={14} aria-hidden="true" />
              </a>
            ))}
          </div>
        )}
        <p className="disclaimer">Research context only, not investment advice. Options involve risk and can lose their full value.</p>
      </section>
    </div>
  )
}
