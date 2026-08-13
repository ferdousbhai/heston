# Architecture

## Product flow

```text
tastytrade REST ──> Cloudflare Worker ──> validated snapshot ──> TanStack DB
        │                    │                                          ▲
        │                    ├──> D1 catalysts + research runs          │
        v                    ├──> Workers AI daily brief                │
DXLink WebSocket ──> MarketFeed Durable Object ──> browser WebSocket ──┘

Grok 4.6 + native X search ──> citation validation ──> D1 catalysts

chat + bounded account context ──> Workers AI plan ──> D1 pending action ──> explicit confirmation
                                                    │
                                                    v
                                    option resolution + dry-run + submit

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
- `server/catalysts.ts`: tastytrade market-metric normalization and D1 calendar reconciliation.
- `server/x-catalysts.ts`: Grok 4.6 native X search, citation allowlisting, schedule guard, D1 persistence, and run telemetry.
- `server/research-sources.ts`: resilient orchestration of bounded research-source collectors.
- `server/research-reddit.ts`: server-only Reddit OAuth and bounded public-post metadata ingestion.
- `server/secrets.ts`: the single boundary for resolving Cloudflare Secrets Store bindings.
- `server/research.ts`: timezone-safe research synthesis, deterministic source attribution, and D1 persistence.
- `server/agent-contracts.ts`: strict model and API schemas plus human-readable action previews.
- `server/brokerage-context.ts`: bounded, normalized positions, balances, working orders, and private watchlists for factual reads.
- `server/agent-planner.ts`: demo parsing and Workers AI planning; its output remains untrusted.
- `server/agent.ts`: expiring confirmation storage and atomic state transitions.
- `server/brokerage.ts`: exact option resolution, tastytrade dry-run, and final dispatch.
- `server/http.ts`: owner-session authorization, same-origin write checks, and safe error responses.

## Invariants

1. Broker secrets, account identifiers, Google OAuth credentials, and Better Auth keys are server-only Cloudflare Secrets Store bindings; no local secret files exist.
2. Google can create a user only for the configured owner email. Every live API request rechecks the database-backed Better Auth session and exact owner email; live writes also require a same-origin browser request.
3. Model output is untrusted and must pass a strict Zod action schema.
4. Account reads are normalized from tastytrade and can answer immediately. Orders, cancellations, and watchlist mutations always produce a pending action.
5. Confirmation tokens are random, stored only as SHA-256 digests, expire after five minutes, and are claimed atomically.
6. Order placement resolves the exact tastytrade option symbol and passes a broker dry-run before submission.
7. Offline state is a validated cache, visibly marked with source and sync status.
8. The research model receives bounded official and public-discussion headlines; citation URLs are attached by code, never accepted from model output.
9. The service worker precaches the app shell only, excludes all `/api/` paths (including the OAuth callback), and uses validated TanStack DB collections as the single offline data cache.
10. Catalyst rows retain source provenance, confidence, and observed timestamps; a refreshed tastytrade symbol replaces its prior tastytrade-sourced dates without touching future sources.
11. The browser never receives a tastytrade access token or quote token. One Durable Object maintains the union of active client symbols and closes DXLink when no clients remain.
12. X findings must target a watched symbol, fall within the validated future horizon, pass the catalyst schema, and use a direct X post URL present in xAI citation metadata.
