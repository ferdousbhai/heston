import { createFileRoute } from '@tanstack/react-router'

import { SitePage } from '../components/site-page'

export const Route = createFileRoute('/privacy')({
  component: PrivacyPage,
  head: () => ({
    meta: [
      { title: 'Privacy — Spice Must Flow' },
      { name: 'description', content: 'How Spice Must Flow handles account, brokerage, market, device, and operational data.' },
    ],
  }),
})

function PrivacyPage() {
  return (
    <SitePage intro="What Spice Must Flow processes, why it is needed, and the choices available to you." title="Privacy policy">
      <p className="site-effective">Effective <time dateTime="2026-08-26">August 26, 2026</time></p>
      <section>
        <h2>Information processed</h2>
        <p>Spice Must Flow may process your Google account identity for sign-in; account, position, order, balance, transaction, and watchlist data from a connected brokerage; symbols, prompts, preferences, confirmations, and research you submit; market and research data requested on your behalf; and limited technical records needed to secure, operate, and diagnose the service.</p>
      </section>
      <section>
        <h2>How information is used</h2>
        <p>This information is used to authenticate you, synchronize the workspace, provide analysis, prepare or carry out actions you explicitly request, enforce risk and authorization boundaries, prevent abuse, and maintain service reliability. Spice Must Flow does not sell personal information or use connected brokerage data for advertising.</p>
      </section>
      <section>
        <h2>Local and cloud storage</h2>
        <p>Some preferences and validated market snapshots are stored on your device for responsiveness and offline access. Public and owner snapshots carry separate audience markers so signed-out pages do not render owner-cached rows. Server-side application state is hosted on Cloudflare. Clearing browser storage removes local data but may not remove server records or data held by connected providers.</p>
      </section>
      <section>
        <h2>Service providers</h2>
        <p>Information is shared only as needed with infrastructure, authentication, market-data, artificial-intelligence, research, and brokerage providers that perform the requested function. Their handling of information is also governed by their own terms and privacy policies.</p>
      </section>
      <section>
        <h2>Retention and security</h2>
        <p>Records are kept only as long as reasonably needed for the service, security, legal obligations, and dispute resolution. Spice Must Flow uses access controls and encrypted transport, but no system can guarantee absolute security. Do not include secrets or unnecessary personal information in prompts or support emails.</p>
      </section>
      <section>
        <h2>Your choices</h2>
        <p>You can disconnect providers, clear local browser data, or request access, correction, or deletion by emailing <a href="mailto:privacy@tryspice.xyz">privacy@tryspice.xyz</a>. Some records may be retained when required for security, legal compliance, or the integrity of completed transactions.</p>
      </section>
      <section>
        <h2>Updates</h2>
        <p>Material changes will be reflected here with a new effective date. Privacy questions can be sent to <a href="mailto:privacy@tryspice.xyz">privacy@tryspice.xyz</a>.</p>
      </section>
    </SitePage>
  )
}
