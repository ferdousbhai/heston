# Architecture

## Product flow

```text
tastytrade REST ──> Cloudflare Worker ──> validated snapshot
                         │                       │
                         │                       v
                    D1 research          TanStack DB local cache
                         │                       │
                  Workers AI daily              v
                     research             reactive mobile UI

chat ──> Workers AI plan ──> D1 pending action ──> explicit confirmation
                                                    │
                                                    v
                                    option resolution + dry-run + submit
```

## Module map

- `domain/market.ts`: Zod contracts and pure volatility classification. This is the shared language between server, cache, tests, and UI.
- `domain/demo.ts`: a complete, deterministic offline fixture kept separate from production rules.
- `data/collections.ts`: persistent TanStack DB collections. It seeds a complete offline experience and reconciles validated cloud snapshots.
- `components/market-screen.tsx`: price, watchlist, and options-temperature experience.
- `components/spice-app.tsx`: small composition root for navigation, sync state, and product surfaces.
- `components/brief-screen.tsx`: daily editorial research.
- `components/agent-screen.tsx`: conversation and confirmation UI.
- `components/market-visuals.tsx`: reusable chart and metric primitives.
- `components/ticker-picker.tsx`: private, position, and public-list selection.
- `server/tastytrade.ts`: OAuth, account/watchlist/position/metric reads, broker transport, and response normalization.
- `server/research-sources.ts`: resilient orchestration of bounded research-source collectors.
- `server/research-reddit.ts`: server-only Reddit OAuth and bounded public-post metadata ingestion.
- `server/secrets.ts`: the single boundary for resolving Cloudflare Secrets Store bindings.
- `server/research.ts`: timezone-safe research synthesis, deterministic source attribution, and D1 persistence.
- `server/agent-contracts.ts`: strict model and API schemas plus human-readable action previews.
- `server/agent-planner.ts`: demo parsing and Workers AI planning; its output remains untrusted.
- `server/agent.ts`: expiring confirmation storage and atomic state transitions.
- `server/brokerage.ts`: exact option resolution, tastytrade dry-run, and final dispatch.
- `server/http.ts`: Cloudflare Access, same-origin write checks, and safe error responses.

## Invariants

1. Broker secrets, account identifiers, and Access configuration are server-only Cloudflare Secrets Store bindings; no local secret files exist.
2. Live requests verify the Cloudflare Access JWT signature, issuer, audience, and allowed email; live writes also require a same-origin browser request.
3. Model output is untrusted and must pass a strict Zod action schema.
4. Read tools can answer immediately. Brokerage writes always produce a pending action.
5. Confirmation tokens are random, stored only as SHA-256 digests, expire after five minutes, and are claimed atomically.
6. Order placement resolves the exact tastytrade option symbol and passes a broker dry-run before submission.
7. Offline state is a validated cache, visibly marked with source and sync status.
8. The research model receives bounded official and public-discussion headlines; citation URLs are attached by code, never accepted from model output.
9. The service worker precaches the app shell only; validated TanStack DB collections are the single offline data cache.
