# Spice

Single-owner options application on Cloudflare with a public market surface, member favorites, and owner-only brokerage and agent capabilities. This file is an index plus the rules that no single file enforces; read the relevant code and its adjacent comments before changing behavior.

## Code index

| Concern | Authoritative code |
| --- | --- |
| Worker routing, HTTP, auth, and scheduled jobs | `src/server.ts`, `src/server/http.ts`, `src/server/auth.ts`, `src/server/scheduled-jobs.ts` |
| Public and private API boundaries | `src/routes/api.public-snapshot.ts`, `src/routes/api.public-symbol-search.ts`, `src/routes/api.public-catalyst-refresh.ts`, `src/routes/api.snapshot.ts`, `src/routes/api.viewer.ts`, `src/routes/api.actions.$actionId.ts` |
| Domain contracts | `src/domain/` |
| Internal watchlist and public universe | `src/server/internal-watchlist.ts`, `src/server/instrument-catalog.ts`, `src/server/public-market-universe.ts`, `src/server/symbol-search.ts`, `src/server/public-symbol-search.ts` |
| Provider access and source storage | `src/server/tastytrade.ts`, `src/server/tastytrade-market-store.ts`, `src/server/yahoo-finance-transport.ts` |
| Browser collections and live overlay | `src/data/collections.ts`, `src/data/favorites.ts`, `src/data/live-market.ts` |
| Research and catalysts | `src/server/research.ts`, `src/server/research-agent.ts`, `src/server/research-agent-tools.ts`, `src/server/research-citation-binding.ts`, `src/server/research-output.ts`, `src/server/catalysts.ts`, `src/server/catalyst-research-exa.ts`, `src/server/catalyst-refresh.ts` |
| Dan and read tools | `src/server/dan-agent.ts`, `src/server/dan-doctrine.ts`, `src/server/brokerage-read-tools.ts`, `src/server/market-research-tools.ts` |
| Order intent, risk, and execution | `src/server/order-intent.ts`, `src/server/portfolio-risk.ts`, `src/server/trade-guards.ts`, `src/server/brokerage.ts`, `src/server/brokerage-reconciliation.ts` |
| Durable Objects | `src/server/broker-gate.ts`, `src/server/market-feed.ts`, `src/server/dan-agent.ts` |
| UI | `src/components/`, `src/styles.css` |
| Local catalog jobs | `ops/instrument-catalog/`, `tools/seed-internal-watchlist.sh` |
| Schema and bindings | `migrations/`, `wrangler.jsonc` |

## Boundaries

- Public, authenticated-member, and owner-only data are separate audiences. Never expose account identity, account-derived data, position flags, provider watchlist names/membership/order, brokerage state, agent state, tokens, or mutations publicly. Persisted browser snapshots are audience-separated, API routes are excluded from service-worker caching, and live DXLink data is owner-only and stays in the in-memory overlay.
- A Google-authenticated member may read and mutate only the source-neutral ticker favorites keyed by their own user id; that identity grants no other authority.
- The bounded D1 internal watchlist (500 symbols) is authoritative and grows on its own: readers admit names to it by searching, and pruning back to a working set stays available rather than routine. A search the loaded list cannot answer falls through to the instrument catalog and, if a symbol resolves, joins the list under the `visitor-search` origin — the weakest live provenance, overwritten by every other origin, never overwriting one, and the first thing a prune drops. The list size is not a request size: broker reads page the list into 100-symbol requests and the live DXLink feed subscribes to at most 100 loaded symbols, selected symbol first. Normal code never reads or mutates tastytrade watchlist endpoints after the one-time bootstrap. Only the source-neutral, alphabetized union is stored for public reads; no public field or ordering reveals priority or provenance. Held names reach the list through Dan's trade-intent and discussion origins, not a recurring position sync.
- D1 source tables hold exactly one provider and one data contract each; views may compose them for display but keep provider labels and per-source observation times. Derived recommendations and projections are never authoritative source storage. Yahoo data is bounded secondary research context only.
- Provider, model, and social content are untrusted. Deterministic schemas bind symbols, dates, provenance, URLs, and actions; model output never authorizes a trade or establishes a trusted citation. Reddit supplies private initial candidates and X Search supplies private deeper discovery; neither may appear in public sources or reader links. A research catalyst is always `estimated`, comes only from a page read and retained by the Worker in that run, and is refused unless its exact date appears in the retained text within the 180-day horizon. The `exa` producer binds the same way against the page an event cites: either Exa's own grounding names that page for that event's date, or the text it returned for the page states the date — a live run showed reporting writes "Sept. 1" for 2026-09-01, so a text scan alone would reject every real finding. It is what reader attention buys: any reader favoriting a symbol, or reviewing one whose next 30 days are empty, asks for a search, and the server runs at most one per symbol every 30 days — recorded in `catalyst_runs` so an unsearched symbol is distinguishable from one whose search found nothing, and never run for a symbol the instrument catalog cannot name. Whatever a run binds is returned to the reader who provoked it so the calendar fills in on that visit. Only a producer's rows reach a reader through its own citation: the runway links the host a date was read from and never the producer that wrote the row, and the broker's earnings rows, whose recorded source is the API specification, carry no link at all.
- The weekday 09:30 New York Workflow injects bounded WallStreetBets context into one model transcript. That model forms at most ten candidates, reads current catalyst and recommendation state, uses native X and Web Search plus the integrated market tools, stages catalyst changes, checks durable link history, and returns the recommendation and link update. Reddit and both native searches may not silently fail; Yahoo remains bounded best-effort secondary context.
- Trading requires explicit order placement, fresh guards, broker dry-run, and a five-minute confirmation draft. Executable multi-leg scope is two-leg long call or put debit verticals; the portfolio guard and server state machine are authoritative over Dan's advice. Never automatically retry an ambiguous broker mutation.
- Secrets and account numbers remain server-side, missing bindings fail closed, and provider bodies or credentials must not enter Worker logs. Model requests use the authenticated `spice` AI Gateway with payload logging, so Dan logs carry private account context and stay Cloudflare-account-only; gateway metadata uses opaque run IDs.

## Working rules

- Domain schemas and pure logic live in `src/domain/`, Cloudflare/provider code in `src/server/`, thin HTTP adapters in `src/routes/api.*`, reactive persistence in `src/data/`, product surfaces in `src/components/`.
- Do not introduce magic numbers or duplicate limits. Every bound must come from an explicit product or risk policy, a documented platform/provider constraint, or a named resource/context budget; define it at the authoritative boundary, derive downstream values from it, and record why it exists and what happens when it is exceeded. Remove a cap when no such reason exists.
- Do not silently coerce, synthesize, truncate, repair, fall back, or substitute data in a way that turns missing, malformed, stale, incomplete, or ambiguous state into apparent success. Defaults apply only to omitted optional input, never to invalid provided input. Fail visibly at the trust boundary unless the product contract explicitly defines best-effort degradation; then make the degraded, unavailable, stale, or truncated state observable and test the failure path.
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
