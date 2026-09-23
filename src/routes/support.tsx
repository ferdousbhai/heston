import { createFileRoute, Link } from '@tanstack/react-router'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { SitePage } from '../components/site-page'

export const Route = createFileRoute('/support')({
  component: SupportPage,
  head: () => ({
    meta: [
      { title: 'Support | Heston' },
      { name: 'description', content: 'Get help with the public market page or the Heston member workspace.' },
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
        <p>Heston has a public, information-only market page. Visitors can read the watchlist, option metrics, catalysts, and recorded evidence, and Google-authenticated members can sync ticker favorites across devices. Signed-in members can also connect their own agent to Heston over MCP; brokerage positions, balances, and trading require the member's own brokerage credentials, which stay on their machine and are never stored here. A member's agent can record catalysts and evidence; Heston verifies every citation before it is shown. Operations remain owner-only.</p>
      </section>
      <section>
        <h2>Report a problem</h2>
        <p>Email <a href="mailto:support@heston.io">support@heston.io</a> with the page you were viewing, what you expected, and what happened. Never send passwords, API keys, brokerage credentials, confirmation codes, or full account numbers.</p>
      </section>
      <section>
        <h2>Privacy and security</h2>
        <p>Send privacy requests to <a href="mailto:privacy@heston.io">privacy@heston.io</a> and suspected vulnerabilities privately to <a href="mailto:support@heston.io?subject=Security%20report">support@heston.io</a>. Legal notices may be sent to <a href="mailto:legal@heston.io">legal@heston.io</a>.</p>
      </section>
      <Alert className="site-callout">
        <AlertTitle>Market information is read-only</AlertTitle>
        <AlertDescription>Signing in can sync ticker favorites, but it cannot access brokerage data or place trades. Market data and research remain informational and may be delayed or wrong. Review the <Link to="/disclosures">risk disclosures</Link>.</AlertDescription>
      </Alert>
    </SitePage>
  )
}
