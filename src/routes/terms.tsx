import { createFileRoute, Link } from '@tanstack/react-router'

import { SitePage } from '../components/site-page'

export const Route = createFileRoute('/terms')({
  component: TermsPage,
  head: () => ({
    meta: [
      { title: 'Terms | spicy.trade' },
      { name: 'description', content: 'Terms governing use of the spicy.trade options-intelligence application.' },
    ],
  }),
})

function TermsPage() {
  return (
    <SitePage intro="The rules for using spicy.trade." title="Terms of use">
      <p className="site-effective">Effective <time dateTime="2026-09-25">September 25, 2026</time></p>
      <section>
        <h2>1. Agreement</h2>
        <p>By using spicy.trade, you agree to these terms, the <Link to="/privacy">Privacy Policy</Link>, and the <Link to="/disclosures">Risk Disclosures</Link>, which are part of these terms. If you do not agree, do not use spicy.trade.</p>
      </section>
      <section>
        <h2>2. Acceptable use</h2>
        <p>Use spicy.trade only lawfully and only through accounts you are authorized to use. You are responsible for your sign-in methods, agent tokens, brokerage credentials, and devices. Do not probe, bypass, overload, or interfere with spicy.trade or another user’s data.</p>
      </section>
      <section>
        <h2>3. No advice; your trades are yours</h2>
        <p>spicy.trade is software. It does not give personalized investment, legal, tax, or accounting advice and is not a fiduciary. When your agent asks it to, spicy.trade places orders through your own brokerage credentials; you make every decision, bear every loss, and should verify orders, fills, and prices with your broker. Your broker and other providers control their own services, data, executions, fees, and terms.</p>
      </section>
      <section>
        <h2>4. Changes and availability</h2>
        <p>spicy.trade may change, be interrupted, or be withdrawn at any time. We may update these terms by posting a new effective date; using spicy.trade afterward means you accept them.</p>
      </section>
      <section>
        <h2>5. No warranty; limited liability</h2>
        <p>To the fullest extent permitted by law, spicy.trade is provided “as is” and “as available,” without warranties of accuracy, fitness for a purpose, non-infringement, uninterrupted operation, or trading results, and spicy.trade is not liable for indirect, incidental, special, or consequential damages or for trading losses arising from its use.</p>
      </section>
      <section>
        <h2>6. Contact</h2>
        <p>Send questions and legal notices to <a href="mailto:legal@spicy.trade">legal@spicy.trade</a>.</p>
      </section>
    </SitePage>
  )
}
