import { createFileRoute } from '@tanstack/react-router'

import { SitePage } from '../components/site-page'

export const Route = createFileRoute('/support')({
  component: SupportPage,
  head: () => ({
    meta: [
      { title: 'Support | Spice' },
      { name: 'description', content: 'How to report a problem or a security issue with Spice.' },
    ],
  }),
})

function SupportPage() {
  return (
    <SitePage intro="How to report a problem or a security issue." title="Support">
      <section>
        <h2>Report a problem</h2>
        <p>Email <a href="mailto:support@spicy.trade">support@spicy.trade</a> with the page or tool you were using, what you expected, and what happened. Never send passwords, API keys, agent tokens, brokerage credentials, confirmation codes, or full account numbers.</p>
      </section>
      <section>
        <h2>Security</h2>
        <p>Report a suspected vulnerability privately to <a href="mailto:support@spicy.trade?subject=Security%20report">support@spicy.trade</a> rather than in public.</p>
      </section>
    </SitePage>
  )
}
