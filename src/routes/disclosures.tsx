import { createFileRoute } from '@tanstack/react-router'

import { SitePage } from '../components/site-page'
import { pageTitle } from '../domain/site'

export const Route = createFileRoute('/disclosures')({
  component: DisclosuresPage,
  head: () => ({
    meta: [
      { title: pageTitle('Risk disclosures') },
      { name: 'description', content: 'Options risk, market data, AI-generated content, and order placement disclosures for spicy.trade.' },
    ],
  }),
})

function DisclosuresPage() {
  return (
    <SitePage intro="What to know before acting on anything spicy.trade shows you." title="Risk disclosures">
      <section>
        <h2>Not investment advice</h2>
        <p>spicy.trade is software run by an individual. It is not a broker-dealer or registered investment adviser, and nothing on it, including the daily brief and its trade ideas, is a recommendation suited to your circumstances. Past performance does not predict future results.</p>
      </section>
      <section>
        <h2>Options are risky</h2>
        <p>Options are complex and can lose value quickly; a long option can expire worthless and lose everything paid for it. Read <a href="https://www.theocc.com/company-information/documents-and-archives/options-disclosure-document" rel="noreferrer" target="_blank">Characteristics and Risks of Standardized Options</a> before trading them. Do not trade what you do not understand or cannot afford to lose.</p>
      </section>
      <section>
        <h2>Data and AI can be wrong</h2>
        <p>Quotes, Greeks, volatility figures, charts, news, and catalyst dates come from third parties, may be delayed, incomplete, wrong, or unavailable, and catalyst dates are estimates. The daily brief is written automatically by an AI model, and research summaries and agent answers are also model output; any of it can be mistaken. Confirm prices and contract details with your broker before acting.</p>
      </section>
      <section>
        <h2>Order placement</h2>
        <p>spicy.trade places an order only through your own tastytrade connection, when your agent asks it to. spicy.trade has no confirmation step of its own; any confirmation prompt comes from the agent you run. Before submitting, it resolves the exact contract, admits only defined-risk orders (a debit opening trade or a close of a verified position), checks the limit price against the current bid and ask, and requires a clean dry-run from your broker. These checks limit mistakes; they do not make a trade sound. A submitted order, or an order status or balance spicy.trade reports, is not proof the order was accepted, filled, cancelled, or priced as shown; verify with your broker. If a submission's outcome is uncertain, spicy.trade does not retry it and blocks further orders on that account until it is reconciled; check your broker before placing it again.</p>
      </section>
      <section>
        <h2>No affiliation</h2>
        <p>spicy.trade connects to tastytrade through tastytrade’s OAuth app program. It is not affiliated with or endorsed by tastytrade or any data provider, and your broker alone executes, clears, and reports your trades.</p>
      </section>
    </SitePage>
  )
}
