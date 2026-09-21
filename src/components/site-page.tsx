import { Link } from '@tanstack/react-router'
import { type ReactNode } from 'react'

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
        <Link aria-label="Heston home" className="site-brand" to="/">
          <img alt="" src="/heston-mark.svg" />
          <span>HESTON</span>
        </Link>
        <nav aria-label="Information">
          <Link to="/support">Support</Link>
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
        <span>© 2026 Heston</span>
        <a href="mailto:support@heston.io">support@heston.io</a>
      </footer>
    </div>
  )
}
