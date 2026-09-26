import { Link } from '@tanstack/react-router'
import { type ReactNode } from 'react'
import { SUPPORT_EMAIL } from '../domain/site'
import { HOME_LINK_LABEL, Wordmark } from './wordmark'

export function SitePage({
  children,
  intro,
  title,
}: {
  children: ReactNode
  intro: string
  title: string
}) {
  return (
    <div className="site-page">
      <a className="skip-link" href="#page-content">Skip to content</a>
      <header className="site-header">
        <Link aria-label={HOME_LINK_LABEL} className="site-brand" to="/watch">
          <img alt="" src="/spice-mark.svg" />
          <Wordmark />
        </Link>
        <nav aria-label="Information">
          <a href={`mailto:${SUPPORT_EMAIL}`}>Support</a>
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
          <Link to="/disclosures">Disclosures</Link>
        </nav>
      </header>
      <main className="site-content" id="page-content">
        <header className="site-title">
          <h1>{title}</h1>
          <p>{intro}</p>
        </header>
        <div className="site-prose">{children}</div>
      </main>
      <footer className="site-footer">
        <span>© 2026 spicy.trade</span>
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </footer>
    </div>
  )
}
