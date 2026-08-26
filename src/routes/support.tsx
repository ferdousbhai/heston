import { createFileRoute, Link } from '@tanstack/react-router'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { SitePage } from '../components/site-page'

export const Route = createFileRoute('/support')({
  component: SupportPage,
  head: () => ({
    meta: [
      { title: 'Support — Spice Must Flow' },
      { name: 'description', content: 'Get help with Spice Must Flow, account access, privacy, or legal questions.' },
    ],
  }),
})

function SupportPage() {
  return (
    <SitePage
      intro="A direct line for account access, product questions, and responsible disclosure."
      title="Support"
    >
      <section>
        <h2>Product and account help</h2>
        <p>Email <a href="mailto:support@tryspice.xyz">support@tryspice.xyz</a>. Include the page you were on, what you expected, and what happened. Never send passwords, API keys, brokerage credentials, or full account numbers.</p>
      </section>
      <section>
        <h2>Privacy and legal</h2>
        <p>For privacy requests, email <a href="mailto:privacy@tryspice.xyz">privacy@tryspice.xyz</a>. For terms or other legal notices, email <a href="mailto:legal@tryspice.xyz">legal@tryspice.xyz</a>.</p>
      </section>
      <section>
        <h2>Security reports</h2>
        <p>Send suspected vulnerabilities privately to <a href="mailto:support@tryspice.xyz?subject=Security%20report">support@tryspice.xyz</a>. Do not access another person’s data, disrupt service, or publish sensitive details before there is time to investigate.</p>
      </section>
      <Alert className="site-callout">
        <AlertTitle>Before trading</AlertTitle>
        <AlertDescription>Spice Must Flow is an analysis and workflow tool, not an investment adviser or broker. Review the <Link to="/disclosures">risk disclosures</Link> before relying on market data or drafting an order.</AlertDescription>
      </Alert>
    </SitePage>
  )
}
