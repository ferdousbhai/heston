import { createFileRoute, Link } from '@tanstack/react-router'

import { SitePage } from '../components/site-page'

export const Route = createFileRoute('/terms')({
  component: TermsPage,
  head: () => ({
    meta: [
      { title: 'Terms | Heston' },
      { name: 'description', content: 'Terms governing use of the Heston options-intelligence application.' },
    ],
  }),
})

function TermsPage() {
  return (
    <SitePage intro="The rules for using Heston and its connected market and brokerage tools." title="Terms of use">
      <p className="site-effective">Effective <time dateTime="2026-08-14">August 14, 2026</time></p>
      <section>
        <h2>1. Agreement</h2>
        <p>By accessing Heston, you agree to these terms and the <Link to="/privacy">Privacy Policy</Link>. If you do not agree, do not use the service.</p>
      </section>
      <section>
        <h2>2. Personal, authorized use</h2>
        <p>You may use Heston only through an account you are authorized to access and only for lawful purposes. You are responsible for protecting your sign-in methods, connected accounts, and devices. Do not probe, bypass, overload, or interfere with the service or another user’s data.</p>
      </section>
      <section>
        <h2>3. Market and brokerage connections</h2>
        <p>Heston can display information from third parties and prepare instructions for a connected brokerage account. Those providers control their own services, data, executions, fees, and terms. A confirmation in Heston is not a guarantee that an order was accepted, filled, cancelled, or priced as shown. Verify material activity with the broker.</p>
      </section>
      <section>
        <h2>4. No investment advice</h2>
        <p>Heston provides software, research organization, and automated analysis. It does not provide personalized investment, legal, tax, or accounting advice and does not act as a fiduciary. You make every investment decision and bear the resulting risk. The <Link to="/disclosures">Risk Disclosures</Link> are part of these terms.</p>
      </section>
      <section>
        <h2>5. Availability and changes</h2>
        <p>The service may change, be interrupted, or be withdrawn. Features that depend on market data, artificial intelligence, third-party APIs, or brokerage systems may be delayed, incomplete, or unavailable. We may update these terms by posting a revised effective date. Continued use after an update means you accept the revised terms.</p>
      </section>
      <section>
        <h2>6. Disclaimers and responsibility</h2>
        <p>To the fullest extent permitted by applicable law, Heston is provided “as is” and “as available,” without warranties of accuracy, fitness, non-infringement, uninterrupted operation, or trading results. To the fullest extent permitted by law, Heston is not liable for indirect, incidental, special, consequential, or trading losses arising from use of the service.</p>
      </section>
      <section>
        <h2>7. Contact</h2>
        <p>Questions or legal notices may be sent to <a href="mailto:legal@heston.io">legal@heston.io</a>.</p>
      </section>
    </SitePage>
  )
}
