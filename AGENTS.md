# Spice agent index

Spice is a single-owner options app on Cloudflare. Public visitors may read a neutral Options Watch, option metrics, catalysts, and the Daily Brief. Google-authenticated members may mutate only their own source-neutral ticker favorites. Only the exact Google-authenticated owner may access positions, balances, transactions, source watchlists, Dan, operations, live account streams, or any other mutation.

This file is an index, not an architecture essay. Read the relevant code and its adjacent comments before changing behavior; durable design decisions belong beside the enforcement code.

## Start here

| Concern | Authoritative code |
| --- | --- |
| Worker entry, routing, Cron | `src/server.ts`, `src/server/scheduled-jobs.ts` |
| Public/owner HTTP boundary | `src/server/http.ts`, `src/server/auth.ts`, `src/routes/api.public-snapshot.ts` |
| Internal watchlist, instrument catalog, one-time broker seed, public universe | `src/server/internal-watchlist.ts`, `src/server/instrument-catalog.ts`, `src/server/public-market-universe.ts`, `src/server/tastytrade.ts`, `migrations/0006_internal_watchlist.sql`, `migrations/0008_instrument_catalog.sql`, `migrations/0009_instrument_catalog_resolution.sql`, `migrations/0011_internal_watchlist_position_origin.sql`, `ops/`, `tools/seed-internal-watchlist.sh` |
| Source-specific market storage and display views | `src/server/tastytrade-market-store.ts`, `src/server/catalysts.ts`, `migrations/0010_source_specific_market_data.sql`, `migrations/0012_codex_catalyst_confidence.sql` |
| Client cache audience and live overlay | `src/data/collections.ts`, `src/data/live-market.ts` |
| Anonymous and account-synced ticker favorites | `src/data/favorites.ts`, `src/routes/api.favorites.ts`, `src/server/favorites.ts`, `migrations/0013_user_favorite_symbols.sql` |
| Market UI and volatility verdict | `src/components/market-screen.tsx`, `src/domain/market.ts` |
| Daily intelligence | `src/server/research.ts`, `src/server/research-output.ts`, `src/server/research-evidence.ts`, `src/server/research-market-movers.ts`, `src/server/research-sources.ts`, `src/server/research-reddit.ts`, `src/server/x-catalysts.ts` |
| AI Gateway run observability | `src/server/ai-gateway.ts`, `src/server/pi-runtime.ts` |
| Catalyst contract, local Codex catalyst research, and D1 persistence | `src/domain/catalyst.ts`, `src/server/catalysts.ts`, `src/server/catalyst-bootstrap.ts`, `ops/catalyst-research/` (runner, `daily.sh`, `systemd/` timer), `migrations/` |
| Dan composition and doctrine | `src/server/dan-agent.ts`, `src/server/dan-doctrine.ts` |
| Dan read tools | `src/server/brokerage-read-tools.ts`, `src/server/brokerage-read-contracts.ts`, `src/server/brokerage-read-normalization.ts`, `src/server/market-research-tools.ts`, `src/server/market-research-contracts.ts`, `src/server/technical-studies.ts`, `src/server/watchlist-tool.ts`, `src/server/research-read-tools.ts`, `src/server/option-greeks-tool.ts` |
| Trade intent, risk, confirmation, execution | `src/server/order-intent.ts`, `src/server/portfolio-risk.ts`, `src/server/agent.ts`, `src/server/brokerage.ts`, `src/server/brokerage-reconciliation.ts` |
| Durable Objects | `src/server/broker-gate.ts`, `src/server/market-feed.ts`, `src/server/dan-agent.ts` |
| UI primitives | `src/components/ui/`, `components.json`, `src/styles.css` |
| Deployment bindings and generated runtime types | `wrangler.jsonc`, `worker-configuration.d.ts` |

## Invariants

- Never expose account identity, account-derived categories, position flags, source watchlist names/membership/order, balances, orders, transactions, chat, operations, tokens, or mutations publicly.
- Spice's bounded D1 internal watchlist is authoritative. The default one-time bootstrap preserves every tastytrade private and public source row and entry privately, resolves the wider instrument catalog, reduces the live list to 100, publishes it, and performs the first owner sync. Normal code must never read or mutate tastytrade watchlist endpoints afterward.
- The maintained internal watchlist is capped at 100 symbols. It prioritizes owner additions, other deterministically validated Spice additions, former private-list members, then eligible individual equities by the retained one-time High Options Volume order. Active positions are prioritized only by the one-time bootstrap; afterwards held names reach the list through Dan's own trade-intent and discussion origins, so no recurring position-to-watchlist sync runs. Adding at capacity evicts the lowest-priority retained seed member; direct deletion requires an explicit owner request. Only the source-neutral, alphabetized union is stored for public reads. No public field or ordering reveals that priority or ticker provenance.
- Public responses and persisted browser snapshots are audience-separated. API routes are excluded from service-worker caching. Live DXLink data is owner-only and stays in the in-memory overlay.
- A Google-authenticated member may read and mutate only the source-neutral ticker favorites keyed by their own Better Auth user id. That identity grants no account, agent, operations, live-stream, watchlist, brokerage, or trading authority.
- D1 stores a typed projection of every interesting tastytrade Equity field, never raw instrument JSON. A transient unresolved response cannot erase resolved identity or tick tiers. Stable identity is used by research and public rendering; trading availability refreshes daily and execution-critical restrictions still refresh in the order path. Yahoo data is bounded, delayed secondary research context only.
- D1 source tables contain exactly one provider and one data contract. Market metrics, quotes, watchlist state, and each catalyst provider stay in separate constrained tables. SQL views may compose source tables for display, but must preserve provider labels and per-source observation times; derived briefs and projections are never authoritative source storage.
- Model and social content are untrusted. Zod and deterministic code bind symbols, dates, provenance, URLs, and actions. A model never chooses a trusted citation or authorizes a trade.
- Local Codex catalyst findings are always `estimated`. A source URL is accepted only when the Codex transcript records an exact direct page open; its display label is derived from the verified hostname, never model-authored source metadata.
- The weekday 09:30 New York daily job starts X, Reddit, and broad Yahoo market-mover research in the same `Promise.all`. X and Reddit feed both the catalyst calendar and Daily Brief and may not silently fail; bounded Yahoo mover/news and official feeds are best-effort secondary context. Mover causes stay explicitly uncertain unless the evidence establishes them. The local Codex catalyst run is complementary, never a substitute: the laptop timer writes only `codex_web_catalysts` ahead of the job, the job reads rows re-verified within seven days as bounded evidence, and a missing or failed local run never affects X, Reddit, or the brief.
- Dan remembers trusted symbols from substantive trade discussions; resolved trade intents and deterministically validated scheduled ideas/movers are also added idempotently to the internal watchlist. Never infer tickers by scraping arbitrary model prose.
- X catalysts require a watched symbol, a valid date within 180 days, and a direct X status URL present in provider citation metadata. Reddit catalyst candidates require an exact Reddit evidence index, watched symbol, valid future date, and are always `estimated`. Earnings come from tastytrade; dividends are excluded.
- Only explicit order placement creates a five-minute confirmation draft. Exact option resolution, fresh portfolio/market guards, and tastytrade dry-run run again before submission. Ambiguous broker mutations are never retried automatically.
- The executable multi-leg scope is limited to two-leg long call or put debit verticals. The high-water portfolio guard and server state machine are authoritative over Dan's advice.
- Secrets and account numbers stay server-side. Missing bindings fail closed; do not add local secret files or write provider bodies, credentials, or tokens to Worker logs. Model requests intentionally use the authenticated `spice` AI Gateway with payload logging so the owner can inspect runs; Dan logs therefore contain private account context and must remain Cloudflare-account-only. Gateway metadata uses opaque run IDs, never account IDs or email.

## Working rules

- Keep domain schemas and pure logic in `src/domain/`, Cloudflare/provider code in `src/server/`, thin HTTP adapters in `src/routes/api.*`, reactive persistence in `src/data/`, and product surfaces in `src/components/`.
- Add or amend an adjacent comment when a non-obvious privacy, trust, persistence, concurrency, or execution decision changes. Do not recreate parallel prose documentation.
- Preserve unrelated dirty-worktree changes. Use `rg` for discovery and `apply_patch` for edits.
- Production auto-deploys from `main` through Cloudflare Workers Builds; do not add a GitHub Actions deploy workflow.
- Before handoff run `git diff --check`, `npm run lint`, `npm test`, `npm run build`, and relevant Playwright tests. Never hit live order endpoints from tests.
- Before Wrangler use, read the local Wrangler skill. Apply D1 migrations before deploying code that reads new columns, then verify public and private boundaries in production.
