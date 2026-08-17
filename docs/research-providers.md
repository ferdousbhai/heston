# Research provider policy

Reviewed: 2026-08-17

## Authority and licensing

Spice uses tastytrade for executable quotes, option contracts, Greeks, and order validation. Research providers are contextual only and cannot authorize or reprice an order.

Both research tools read Yahoo Finance through `yahoo-finance2`. Yahoo is an unofficial, unauthenticated, secondary source: it carries no service guarantee, no licensed redistribution right, and no support commitment. Treat it as background context only, keep the secondary-source warning attached to tool output, and verify material claims against primary filings before increasing risk.

Financial Modeling Prep was evaluated for price history and removed on 2026-08-17. It never completed the live comparison its trial required, and its personal-plan terms restrict use to individual, non-commercial purposes with display and redistribution gated behind a separate agreement — a permanent ceiling on any multi-user or public deployment. If a licensed primary provider is adopted later, add it behind `PriceHistoryProvider` rather than in the tool.

## Integration contract

- Neither research tool takes a credential. Yahoo requests are unauthenticated, so there is no research secret in the Secrets Store and no research binding in `wrangler.jsonc`.
- Requests pass through a bounded fetch wrapper: a 12-second timeout and a 2 MB response limit, with `yahoo-finance2` capped at two concurrent requests.
- Failures become stable `ResearchProviderError` categories (`src/server/research-provider.ts`). Provider bodies and raw payloads do not enter errors or model context.
- Dan's public tools remain `read_price_history` and `read_company_fundamentals`; provider selection is server-controlled behind `PriceHistoryProvider` and `CompanyFundamentalsProvider`.
- Price history fetches the `chart` module at `1d` interval. Yahoo's OHLCV is split-adjusted and its `adjclose` additionally applies dividend adjustments; when `adjclose` is absent the raw close is used. `period2` is extended one day because Yahoo treats it as exclusive.
- Rows missing any field are skipped and counted in `skippedRowCount`. Duplicate dates, a cross-symbol response, an oversized payload, and an empty result are all fatal `invalid-response` errors, because each would silently corrupt local aggregation.
- Tastytrade dot-class notation is translated to Yahoo dash notation (`BRK.B` → `BRK-B`) only at the provider boundary.
- Daily observations are aggregated locally for weekly and monthly requests. SMA, EMA, RSI, MACD, and Bollinger studies are calculated locally from the adjusted close.
- Results state provider, source URL, observation date, fetch time, end-of-day delay, adjustment methodology, and stale status. They are never current executable quotes.

API reference:

- [yahoo-finance2 chart module](https://github.com/gadicc/node-yahoo-finance2)

## Verification record

Deterministic fixture tests in `test/market-research-tools.test.ts` cover ascending normalization of descending provider rows, incomplete rows, missing adjusted closes, duplicate dates, cross-symbol responses, empty history, provider failure, daily/weekly/monthly output, local study alignment after row truncation, invalid ranges, and New York default dates.

Live verification on 2026-08-17 against the real Yahoo endpoint: `AAPL`, `SPY`, and `BRK.B` each returned 53 rows over 2026-06-01 to 2026-08-14 with zero skipped rows, correct inclusive range endpoints, resolved instrument names, and aligned SMA and MACD studies. A 2024 full-year `AAPL` read confirmed the dividend adjustment is real rather than a mirror of close — all 252 rows diverged (2024-01-02: 183.40 adjusted versus 185.64 close).

Still unverified against live data: small caps, ADRs, recent listings, inactive or delisted symbols, and symbols with a recent split or special dividend. Run those before relying on price history for anything beyond context.
