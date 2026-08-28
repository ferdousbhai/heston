# Spice

Single-owner options application on Cloudflare with a public market surface, member favorites, and owner-only brokerage and agent capabilities. This file is an index plus the rules that no single file enforces; read the relevant code and its adjacent comments before changing behavior.

## Code index

| Concern | Authoritative code |
| --- | --- |
| Worker routing, HTTP, auth, and scheduled jobs | `src/server.ts`, `src/server/http.ts`, `src/server/auth.ts`, `src/server/scheduled-jobs.ts` |
| Public and private API boundaries | `src/routes/api.public-snapshot.ts`, `src/routes/api.snapshot.ts`, `src/routes/api.viewer.ts`, `src/routes/api.actions.$actionId.ts` |
| Domain contracts | `src/domain/` |
| Internal watchlist and public universe | `src/server/internal-watchlist.ts`, `src/server/instrument-catalog.ts`, `src/server/public-market-universe.ts` |
| Provider access and source storage | `src/server/tastytrade.ts`, `src/server/tastytrade-market-store.ts`, `src/server/yahoo-finance-transport.ts` |
| Browser collections and live overlay | `src/data/collections.ts`, `src/data/favorites.ts`, `src/data/live-market.ts` |
| Research and catalysts | `src/server/research.ts`, `src/server/research-evidence.ts`, `src/server/research-output.ts`, `src/server/catalysts.ts`, `src/server/x-catalysts.ts`, `src/server/catalyst-bootstrap.ts` |
| Dan and read tools | `src/server/dan-agent.ts`, `src/server/dan-doctrine.ts`, `src/server/brokerage-read-tools.ts`, `src/server/market-research-tools.ts` |
| Order intent, risk, and execution | `src/server/order-intent.ts`, `src/server/portfolio-risk.ts`, `src/server/trade-guards.ts`, `src/server/brokerage.ts`, `src/server/brokerage-reconciliation.ts` |
| Durable Objects | `src/server/broker-gate.ts`, `src/server/market-feed.ts`, `src/server/dan-agent.ts` |
| UI | `src/components/`, `src/styles.css` |
| Local Codex catalyst research and catalog jobs | `ops/catalyst-research/` (runner, `daily.sh`, `systemd/` timer), `ops/instrument-catalog/`, `tools/seed-internal-watchlist.sh` |
| Schema and bindings | `migrations/`, `wrangler.jsonc` |

## Boundaries

- Public, authenticated-member, and owner-only data are separate audiences. Never expose account identity, account-derived data, position flags, provider watchlist names/membership/order, brokerage state, agent state, tokens, or mutations publicly. Persisted browser snapshots are audience-separated, API routes are excluded from service-worker caching, and live DXLink data is owner-only and stays in the in-memory overlay.
- A Google-authenticated member may read and mutate only the source-neutral ticker favorites keyed by their own user id; that identity grants no other authority.
- The bounded D1 internal watchlist (100 symbols) is authoritative. Normal code never reads or mutates tastytrade watchlist endpoints after the one-time bootstrap. Only the source-neutral, alphabetized union is stored for public reads; no public field or ordering reveals priority or provenance. Held names reach the list through Dan's trade-intent and discussion origins, not a recurring position sync.
- D1 source tables hold exactly one provider and one data contract each; views may compose them for display but keep provider labels and per-source observation times. Derived briefs and projections are never authoritative source storage. Yahoo data is bounded secondary research context only.
- Provider, model, and social content are untrusted. Deterministic schemas bind symbols, dates, provenance, URLs, and actions; model output never authorizes a trade or establishes a trusted citation. X catalysts need a watched symbol, a date within 180 days, and a direct X status URL from provider citation metadata; Reddit candidates need an exact evidence index and are always `estimated`; local Codex findings are always `estimated` and a source URL is accepted only when the Codex transcript records an exact page open.
- The weekday 09:30 New York job runs X, Reddit, and Yahoo mover research together; X and Reddit may not silently fail, Yahoo and official feeds are best-effort. The local Codex catalyst run is complementary, never a substitute: it writes only `codex_web_catalysts` ahead of the job, the job reads rows re-verified within seven days as bounded evidence, and a missing local run never affects the brief.
- Trading requires explicit order placement, fresh guards, broker dry-run, and a five-minute confirmation draft. Executable multi-leg scope is two-leg long call or put debit verticals; the portfolio guard and server state machine are authoritative over Dan's advice. Never automatically retry an ambiguous broker mutation.
- Secrets and account numbers remain server-side, missing bindings fail closed, and provider bodies or credentials must not enter Worker logs. Model requests use the authenticated `spice` AI Gateway with payload logging, so Dan logs carry private account context and stay Cloudflare-account-only; gateway metadata uses opaque run IDs.

## Working rules

- Domain schemas and pure logic live in `src/domain/`, Cloudflare/provider code in `src/server/`, thin HTTP adapters in `src/routes/api.*`, reactive persistence in `src/data/`, product surfaces in `src/components/`.
- Record a non-obvious privacy, trust, persistence, concurrency, or execution decision in an adjacent comment when it changes; do not write parallel prose documentation.
- Preserve unrelated dirty-worktree changes. Use `rg` for discovery.
- Production auto-deploys from `main` through Cloudflare Workers Builds; do not add a deploy workflow. Apply D1 migrations (`wrangler d1 migrations apply spice-production --remote`) before pushing code that reads new columns, and only when asked.

## Commands

```sh
git diff --check
npm run lint
npm test
npm run build
npm run test:e2e
```

Tests must never call live order endpoints.
