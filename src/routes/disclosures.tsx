import { createFileRoute } from '@tanstack/react-router'

import { SitePage } from '../components/site-page'

export const Route = createFileRoute('/disclosures')({
  component: DisclosuresPage,
  head: () => ({
    meta: [
      { title: 'Risk disclosures | Heston' },
      { name: 'description', content: 'Important market-data, options-trading, and automated-analysis disclosures for Heston.' },
    ],
  }),
})

function DisclosuresPage() {
  return (
    <SitePage intro="Important limits of market data, automated analysis, and options trading." title="Risk disclosures">
      <section>
        <h2>Trading can cause substantial loss</h2>
        <p>Stocks, options, and other securities can lose value rapidly. Options may expire worthless, involve leverage, and expose you to losses that can exceed the amount initially paid or received, depending on the strategy. Past performance and simulated results do not predict future outcomes.</p>
      </section>
      <section>
        <h2>Not a broker or adviser</h2>
        <p>Heston is a software tool. It is not a broker-dealer, investment adviser, exchange, tax adviser, or fiduciary. Research, scores, summaries, risk estimates, recommendations, and agent responses are informational and may not be suitable for your circumstances.</p>
      </section>
      <section>
        <h2>Data and models have limits</h2>
        <p>Quotes, Greeks, volatility measures, news, catalysts, balances, and order status may be delayed, estimated, incomplete, or wrong. Automated and artificial-intelligence outputs can omit context or make errors. Confirm prices, contract details, buying power, disclosures, and order status with the relevant primary source before acting.</p>
      </section>
      <section>
        <h2>Confirmations are safeguards, not guarantees</h2>
        <p>Heston requires explicit confirmation before order placement and may apply risk boundaries. Cancellations and watchlist changes do not require that extra step when explicitly requested. Those controls reduce accidental actions but do not make a trade safe, profitable, appropriate, or certain to execute. Network and provider failures can leave outcomes uncertain; reconcile directly with the broker before retrying.</p>
      </section>
      <section>
        <h2>Your responsibility</h2>
        <p>You are solely responsible for deciding whether to trade, reviewing every order, understanding the applicable broker and exchange rules, and monitoring open positions. If you do not understand an instrument or cannot bear its potential loss, do not trade it.</p>
      </section>
      <section>
        <h2>Questions</h2>
        <p>Questions about these disclosures may be sent to <a href="mailto:legal@heston.io">legal@heston.io</a>.</p>
      </section>
    </SitePage>
  )
}
