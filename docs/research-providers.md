# Research provider policy and FMP trial

Reviewed: 2026-08-14

## Authority and licensing

Spice uses tastytrade for executable quotes, option contracts, Greeks, and order validation. Research providers are contextual only and cannot authorize or reprice an order.

FMP's personal plans are restricted to individual, non-commercial use. FMP also states that display or redistribution requires a separate agreement. The current integration is therefore approved only for Spice's authenticated single-owner deployment. Before enabling another user, public output, or commercial use, obtain and record an appropriate FMP display/redistribution agreement. Do not treat possession of an API key as licensing approval.

References:

- [FMP pricing and display notice](https://site.financialmodelingprep.com/developer/docs/pricing/)
- [FMP Terms of Service](https://site.financialmodelingprep.com/developer/docs/terms-of-service)

## Integration contract

- The API key is read from the `FMP_API_KEY` Secrets Store binding and sent only in the `apikey` request header.
- Requests use the fixed `https://financialmodelingprep.com/stable/` origin, a 12-second timeout, and a 4 MiB response limit.
- Statuses and malformed payloads become stable `ResearchProviderError` categories. Provider bodies, credential-bearing URLs, and API keys do not enter errors or model context.
- Dan's public tool remains `read_price_history`; provider selection is server-controlled.
- The tool fetches `historical-price-eod/non-split-adjusted` for raw OHLCV and `historical-price-eod/dividend-adjusted` for adjusted close. Rows are matched by exact symbol and date.
- Daily observations are aggregated locally for weekly and monthly requests. SMA, EMA, RSI, MACD, and Bollinger studies are calculated locally from the adjusted close.
- Results state provider, source URL, observation date, fetch time, end-of-day delay, adjustment methodology, and stale status. They are never current executable quotes.

API references:

- [FMP stable API and header authorization](https://site.financialmodelingprep.com/developer/docs/stable)
- [FMP dividend-adjusted EOD endpoint](https://site.financialmodelingprep.com/developer/docs/stable/historical-price-eod-dividend-adjusted)
- [FMP unadjusted EOD endpoint](https://site.financialmodelingprep.com/developer/docs/stable/historical-price-eod-non-split-adjusted)

## Trial record

The deterministic fixture trial covers:

- exact symbol/date reconciliation;
- descending provider rows and local ascending normalization;
- unadjusted OHLCV plus a distinct dividend-adjusted close;
- incomplete rows, missing adjusted dates, duplicate dates, and cross-symbol responses;
- daily, weekly, and monthly output;
- local study alignment after row truncation;
- invalid ranges, New York default dates, malformed JSON, missing credentials, rate limits, and redacted errors.

A live Premium comparison is still required before declaring the provider fully promoted. Run it for a large cap, small cap, ETF, ADR, recent listing, inactive/delisted symbol, dot-class ticker, and symbols with recent splits, ordinary dividends, and special dividends. Record field availability, latency, provider observation dates, missing trading days, and tolerances versus the temporary Yahoo shadow. Include a weekend and a market holiday.

Promotion requires all fixture tests and the live comparison to pass, the owner-only licensing assumption to remain true, and the production secret to be configured. Rollback is server-side: retain the public tool contract and switch the price-history provider behind the provider interface. Yahoo price history code has been removed; `yahoo-finance2` remains temporarily because company fundamentals still use it and can be deleted after the SEC fundamentals migration.
