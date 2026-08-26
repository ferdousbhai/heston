import { createFileRoute, Link } from '@tanstack/react-router'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { SitePage } from '../components/site-page'

export const Route = createFileRoute('/support')({
  component: SupportPage,
  head: () => ({
    meta: [
      { title: 'Support | Spice Must Flow' },
      { name: 'description', content: 'Get help with the public market page or the private Spice Must Flow owner workspace.' },
    ],
  }),
})

function SupportPage() {
  return (
    <SitePage
      intro="Help with the public market page or the private owner workspace."
      title="Support"
    >
      <section>
        <h2>What this site is</h2>
        <p>Spice Must Flow is a single-owner application with a public, information-only market page. Visitors can read the watchlist, option metrics, catalysts, and daily research. Brokerage positions, balances, Dan, and every trading action are available only inside the owner workspace. There is no public registration or public trading access.</p>
      </section>
      <section>
        <h2>Report a problem</h2>
        <p>Email <a href="mailto:support@tryspice.xyz">support@tryspice.xyz</a> with the page you were viewing, what you expected, and what happened. Never send passwords, API keys, brokerage credentials, confirmation codes, or full account numbers.</p>
      </section>
      <section>
        <h2>Privacy and security</h2>
        <p>Send privacy requests to <a href="mailto:privacy@tryspice.xyz">privacy@tryspice.xyz</a> and suspected vulnerabilities privately to <a href="mailto:support@tryspice.xyz?subject=Security%20report">support@tryspice.xyz</a>. Legal notices may be sent to <a href="mailto:legal@tryspice.xyz">legal@tryspice.xyz</a>.</p>
      </section>
      <Alert className="site-callout">
        <AlertTitle>Public information is read-only</AlertTitle>
        <AlertDescription>The public page cannot access brokerage data or place trades. Market data and research remain informational and may be delayed or wrong. Review the <Link to="/disclosures">risk disclosures</Link>.</AlertDescription>
      </Alert>
    </SitePage>
  )
}
