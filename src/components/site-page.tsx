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
        <Link aria-label="Spice Must Flow home" className="site-brand" to="/">
          <img alt="" src="/spice-mark.svg" />
          <span>SPICE MUST FLOW</span>
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
          <p>TRYSPICE.XYZ</p>
          <h1>{title}</h1>
          <p>{intro}</p>
        </header>
        <div className="site-prose">{children}</div>
      </main>
      <footer className="site-footer">
        <span>© 2026 Spice</span>
        <a href="mailto:support@tryspice.xyz">support@tryspice.xyz</a>
      </footer>
    </div>
  )
}
