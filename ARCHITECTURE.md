# Architecture

## Product flow

```text
tastytrade REST ──> Cloudflare Worker ──> validated snapshot ──> TanStack DB
        │                    │                                          ▲
        │                    ├──> D1 catalysts + research runs          │
        v                    ├──> Workers AI daily brief                │
DXLink WebSocket ──> MarketFeed Durable Object ──> browser WebSocket ──┘

Grok 4.6 + native X search ──> citation validation ──> D1 catalysts

chat + always-on account context ──> Grok tool loop ──> order draft in D1 ──> explicit placement confirmation
              │                         │                         │
              │                         v                         v
              │                 bounded read tools      option resolution + dry-run + submit
              └── balances, positions, working orders, recent trades

Google OAuth ──> Better Auth ──> D1 session ──> exact-owner API boundary
```

## Module map

- `domain/market.ts`: Zod contracts and pure volatility classification. This is the shared language between server, cache, tests, and UI.
- `domain/catalyst.ts`: source-aware catalyst contract plus timezone-safe upcoming-event selection and stable watchlist ordering.
- `domain/demo.ts`: a complete, deterministic offline fixture kept separate from production rules.
- `data/collections.ts`: persistent TanStack DB collections. It seeds a complete offline experience and reconciles validated cloud snapshots.
- `data/live-market.ts`: browser WebSocket lifecycle and reconnect policy; validated events update the same ticker collection.
- `components/market-screen.tsx`: price, watchlist, and options-metrics experience.
- `components/spice-app.tsx`: small composition root for navigation, sync state, and product surfaces.
- `components/brief-screen.tsx`: daily editorial research.
- `components/agent-screen.tsx`: conversation and confirmation UI.
- `components/market-visuals.tsx`: reusable chart and metric primitives.
- `components/ticker-picker.tsx`: private, position, and public-list selection.
- `components/auth-gate.tsx`: branded Google entry point, session bootstrap, and offline continuation.
- `server/auth.ts`: Better Auth construction, Cloudflare D1 sessions, encrypted Google tokens, and exact-owner enforcement.
- `server/tastytrade.ts`: OAuth, account/watchlist/position/metric reads, broker transport, and response normalization.
- `server/market-feed.ts`: account-scoped Durable Object that owns DXLink auth, union subscriptions, normalized fanout, and reconnects.
- `server/market-feed-contracts.ts`: shared symbol and live-event validation boundary.
- `server/catalysts.ts`: tastytrade earnings normalization and D1 calendar reconciliation.
- `server/x-catalysts.ts`: Grok 4.6 native X search, citation allowlisting, schedule guard, D1 persistence, and run telemetry.
- `server/research-sources.ts`: resilient orchestration of bounded research-source collectors.
- `server/research-reddit.ts`: server-only Reddit OAuth and bounded public-post metadata ingestion.
- `server/secrets.ts`: the single boundary for resolving Cloudflare Secrets Store bindings.
- `server/research.ts`: timezone-safe research synthesis, deterministic source attribution, and D1 persistence.
- `server/agent-contracts.ts`: strict model and API schemas plus human-readable action previews.
- `server/brokerage-context.ts`: strict, timestamped always-on balances, positions, full working-order legs, and recent Trade transactions. Account identity and deprecated REST marks are omitted from model context.
- `server/brokerage-read-tools.ts`: bounded, read-only account history, market metrics/status, symbol search, progressive option-contract discovery, and exact tuple-resolved bid/ask quotes.
- `server/option-greeks-tool.ts`: exact human option tuple resolution plus live Greeks through the shared MarketFeed relay.
- `server/account-action-tools.ts`: direct, narrowly validated order cancellation and private-watchlist writes.
- `server/watchlist-tool.ts`: progressive private/public watchlist reads; names and counts precede exact-list symbols.
- `server/research-read-tools.ts`: bounded D1 reads for catalysts and the latest daily research brief.
- `server/dan-agent.ts`: durable Pi/Grok conversation loop and the composition root for context, read tools, direct cancellation/watchlist tools, and confirmation-gated order placement.
- `server/agent-planner.ts`: credential-free demo order parsing; its output remains untrusted.
- `server/agent.ts`: expiring order-confirmation storage and atomic state transitions.
- `server/brokerage.ts`: exact option resolution, tastytrade dry-run, and final dispatch.
- `server/http.ts`: owner-session authorization, same-origin write checks, and safe error responses.

## Invariants

1. Broker credentials, Google OAuth credentials, and Better Auth keys are server-only Cloudflare Secrets Store bindings; no local secret files exist. The tastytrade account identifier is resolved server-side and never enters browser or model context.
2. Google can create a user only for the single allowed owner email. Every live API request rechecks the database-backed Better Auth session and exact owner email; live writes also require a same-origin browser request.
3. Model output is untrusted and must pass a strict Zod action schema.
4. Account reads are normalized from tastytrade and can answer immediately. Only order placement produces a pending action; an explicitly requested cancellation or private-watchlist mutation uses its narrow direct tool.
5. Confirmation tokens are random, stored only as SHA-256 digests, expire after five minutes, and are claimed atomically.
6. Order placement resolves the exact tastytrade option symbol and passes a broker dry-run before submission.
7. Offline state is a validated local cache. Synchronization is automatic and does not require a visible manual sync control.
8. The research model receives bounded official and public-discussion headlines; citation URLs are attached by code, never accepted from model output.
9. The service worker precaches the app shell only, excludes all `/api/` paths (including the OAuth callback), and uses validated TanStack DB collections as the single offline data cache.
10. Only earnings and material scheduled agent findings are first-class catalysts. Catalyst rows retain source provenance, confidence, and observed timestamps, and a refreshed tastytrade symbol replaces its prior tastytrade-sourced dates without touching other sources.
11. The browser never receives a tastytrade access token or quote token. One Durable Object maintains the union of active client symbols and closes DXLink when no clients remain.
12. X findings must target a watched symbol, fall within the validated future horizon, pass the catalyst schema, and use a direct X post URL present in xAI citation metadata.
13. Dan receives account state on every turn, but watchlists, deeper history, broader metrics, option chains, catalysts, and research are fetched only through bounded read-only tools. Tool output is provenance-tagged and never contains the tastytrade account number.
