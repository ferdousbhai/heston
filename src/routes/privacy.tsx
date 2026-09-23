import { createFileRoute } from '@tanstack/react-router'

import { SitePage } from '../components/site-page'

export const Route = createFileRoute('/privacy')({
  component: PrivacyPage,
  head: () => ({
    meta: [
      { title: 'Privacy | Heston' },
      { name: 'description', content: 'How Heston handles account, brokerage, market, device, and operational data.' },
    ],
  }),
})

function PrivacyPage() {
  return (
    <SitePage intro="What Heston processes, why it is needed, and the choices available to you." title="Privacy policy">
      <p className="site-effective">Effective <time dateTime="2026-09-23">September 23, 2026</time></p>
      <section>
        <h2>Information processed</h2>
        <p>Heston may process your Google account identity for sign-in; your ticker favorites; the labels of agent tokens you create (only a digest of each token is stored) and the agent clients you approve; symbols you or your agent look up, which join the shared watchlist; catalysts and evidence your agent records, which every reader sees; balance, position, order, trade, and cash-movement data read from your brokerage through your own credential, only on a request that presents it; records of orders placed through Heston, kept so an ambiguous submission can be reconciled; market and research data requested on your behalf; and limited technical records needed to secure, operate, and diagnose the service. Your brokerage credential is never stored by Heston, and your agent&apos;s prompts run on your own machine rather than here.</p>
      </section>
      <section>
        <h2>How information is used</h2>
        <p>This information is used to authenticate you, synchronize the workspace, provide analysis, prepare or carry out actions you explicitly request, enforce risk and authorization boundaries, prevent abuse, and maintain service reliability. Heston does not sell personal information or use connected brokerage data for advertising.</p>
      </section>
      <section>
        <h2>Local and cloud storage</h2>
        <p>Some preferences and validated market snapshots are stored on your device for responsiveness. If you sign in, ticker favorites are also stored with your account so they can sync across devices. Public and owner snapshots carry separate audience markers so signed-out pages do not render owner-cached rows. Server-side application state is hosted on Cloudflare. Clearing browser storage removes local data but may not remove server records or data held by connected providers.</p>
      </section>
      <section>
        <h2>Service providers</h2>
        <p>Information is shared only as needed with infrastructure, authentication, market-data, artificial-intelligence, research, and brokerage providers that perform the requested function. Their handling of information is also governed by their own terms and privacy policies.</p>
      </section>
      <section>
        <h2>Retention and security</h2>
        <p>Records are kept only as long as reasonably needed for the service, security, legal obligations, and dispute resolution. Heston uses access controls and encrypted transport, but no system can guarantee absolute security. Do not include secrets or unnecessary personal information in research your agent records or in support emails.</p>
      </section>
      <section>
        <h2>Your choices</h2>
        <p>You can disconnect providers, clear local browser data, or request access, correction, or deletion by emailing <a href="mailto:privacy@heston.io">privacy@heston.io</a>. Some records may be retained when required for security, legal compliance, or the integrity of completed transactions.</p>
      </section>
      <section>
        <h2>Updates</h2>
        <p>Material changes will be reflected here with a new effective date. Privacy questions can be sent to <a href="mailto:privacy@heston.io">privacy@heston.io</a>.</p>
      </section>
    </SitePage>
  )
}
