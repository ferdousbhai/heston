# Spice Must Flow

Spice Must Flow is a mobile-first options intelligence app: Apple Stocks-style market scanning, editorial daily research, local-first TanStack DB state, tastytrade account context, and a confirmation-gated trading agent.

The daily issue combines live tastytrade option metrics with bounded Federal Reserve, SEC, and authenticated Reddit feeds. A separate Grok 4.6 workflow searches X every weekday for scheduled catalysts. Only direct X status URLs returned in provider citation metadata are accepted into the calendar.

## Run it

```sh
npm install
npm run dev
```

Production runs with `APP_MODE=live`. The Vite development server explicitly overrides that value to `demo` and removes remote Secret Store bindings, so the complete local interface works without credentials. Demo confirmations never call a brokerage.

## Architecture

The code follows four clear boundaries:

- `src/domain/` contains pure schemas, catalyst ordering, volatility classification, and demo fixtures. It has no framework or network dependency.
- `src/data/` owns TanStack DB collections and cloud-to-local reconciliation. The UI reads reactive collections, not API response objects.
- `src/components/` contains one product surface per module. `spice-app.tsx` only selects data, coordinates sync, and composes screens.
- `src/server/` owns Cloudflare and tastytrade concerns. Secrets, account numbers, raw broker responses, and order dispatch never cross into client code.

Server routes in `src/routes/api.*.ts` are deliberately thin validation and HTTP adapters. See [ARCHITECTURE.md](./ARCHITECTURE.md) for the flow and safety invariants.

## Cloudflare setup

1. Create the D1 database and replace the placeholder `database_id` in `wrangler.jsonc`.
2. Apply migrations:

   ```sh
   npx wrangler d1 migrations apply spice --remote
   ```

3. Create the missing entries in the account's shared Cloudflare Secrets Store. Each command prompts for the value and writes it directly to Cloudflare; do not pass values on the command line:

   ```sh
   SPICE_SECRET_STORE_ID=a436a6cefedc4acd8bb920cdbc202c1c
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name tastytrade-client-secret --scopes workers --remote
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name tastytrade-refresh-token --scopes workers --remote
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name tastytrade-account-number --scopes workers --remote
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name xai --scopes workers --remote
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name account-ai-gateway --scopes workers --remote
   ```

   The existing `reddit-client-id` and `reddit-client-secret` entries are reused by name. Secret values cannot be read back by Spice, Wrangler, or this repository.

4. Put the Worker behind Cloudflare Access, then add its verifier settings to the same Secrets Store:

   ```sh
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name spice-access-team-domain --scopes workers --remote
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name spice-access-aud --scopes workers --remote
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name spice-access-owner-email --scopes workers --remote
   ```

   Live API routes verify the Access JWT signature, issuer, application audience, and your exact email. A forwarded identity header alone is deliberately insufficient.
5. Deploy with `npm run deploy`. `wrangler.jsonc` is already configured for live mode, the account-scoped market-feed Durable Object, and the New York-time guarded cron windows.

`wrangler.jsonc` binds the shared Reddit, xAI, AI Gateway, tastytrade, and Access Secret Store handles. There is intentionally no `.env`, `.env.example`, or `.dev.vars` workflow in this project; local development stays in demo mode and never needs production credentials.

Cloudflare reference: [Secrets Store bindings](https://developers.cloudflare.com/secrets-store/integrations/workers/).

Paired UTC cron windows cover both US daylight and standard time. The scheduled handler runs the daily brief only at 09:30 New York and the X catalyst workflow only at 18:30 New York on weekdays.

## Checks

```sh
npm test
npm run build
npm run test:e2e
```

No live order is submitted directly from chat. Dan creates a bounded draft stored in D1 with a hashed, one-time, five-minute token. Confirmation atomically claims it, resolves the exact option instrument, runs tastytrade’s dry-run endpoint, and only then submits.

The live options metrics use the fields actually supplied by tastytrade’s REST API: IV rank, IV percentile, IV index, and liquidity rating. The app never fills unsupported live fields with demo estimates. One account-scoped Durable Object owns the secret-bearing tastytrade DXLink connection. Authenticated browser sessions subscribe to that relay, which unions requested symbols, streams normalized Quote, Trade, and five-minute Candle events into TanStack DB, and closes the upstream socket when the last client disconnects.

Upcoming earnings and dividend dates are normalized from tastytrade market metrics into the D1 `catalysts` table with source, update time, confidence, and market timing. TanStack DB keeps the validated calendar available offline, and watchlists order symbols by their nearest upcoming catalyst while preserving their original order for symbols without one.

Dan loads bounded positions, balances, working orders, and private watchlists as factual account context. It can draft add/remove watchlist mutations in addition to orders and cancellations; every tastytrade write uses the same expiring confirmation state machine.
