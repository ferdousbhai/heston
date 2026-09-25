import { createFileRoute, Link } from '@tanstack/react-router'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { SitePage } from '../components/site-page'

export const Route = createFileRoute('/support')({
  component: SupportPage,
  head: () => ({
    meta: [
      { title: 'Support | Spice' },
      { name: 'description', content: 'Get help with the public market page or the Spice member workspace.' },
    ],
  }),
})

function SupportPage() {
  return (
    <SitePage
      intro="Help with the public market page or the member workspace."
      title="Support"
    >
      <section>
        <h2>What this site is</h2>
        <p>Spice has a public, information-only market page. Visitors can read the watchlist, option metrics, catalysts, and recorded evidence, and Google-authenticated members can sync ticker favorites across devices. Any agent can also read the public market over MCP without signing in. A signed-in member's agent adds live broker-backed quotes, option chains, and Greeks, and can record catalysts and evidence; Spice verifies every citation before it is shown. Brokerage positions, balances, and trading additionally require the member's own brokerage credentials, which a local proxy on their machine sends with each request and which are never stored here. Operations remain owner-only.</p>
      </section>
      <section>
        <h2>Report a problem</h2>
        <p>Email <a href="mailto:support@spicy.trade">support@spicy.trade</a> with the page you were viewing, what you expected, and what happened. Never send passwords, API keys, brokerage credentials, confirmation codes, or full account numbers.</p>
      </section>
      <section>
        <h2>Privacy and security</h2>
        <p>Send privacy requests to <a href="mailto:privacy@spicy.trade">privacy@spicy.trade</a> and suspected vulnerabilities privately to <a href="mailto:support@spicy.trade?subject=Security%20report">support@spicy.trade</a>. Legal notices may be sent to <a href="mailto:legal@spicy.trade">legal@spicy.trade</a>.</p>
      </section>
      <Alert className="site-callout">
        <AlertTitle>Market information is read-only</AlertTitle>
        <AlertDescription>Signing in can sync ticker favorites, but it cannot access brokerage data or place trades. Market data and research remain informational and may be delayed or wrong. Review the <Link to="/disclosures">risk disclosures</Link>.</AlertDescription>
      </Alert>
    </SitePage>
  )
}
