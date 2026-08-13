# Spice Must Flow

Spice Must Flow is a mobile-first options intelligence app: Apple Stocks-style market scanning, editorial daily research, local-first TanStack DB state, tastytrade account context, and an order-confirming trading agent.

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

1. `wrangler.jsonc` already binds the deployed `spice` D1 database. For a separate Cloudflare account, create a replacement database and update that binding's `database_id`.
2. Apply migrations:

   ```sh
   npx wrangler d1 migrations apply spice --remote
   ```

3. Create the missing entries in the account's shared Cloudflare Secrets Store. Each command prompts for the value and writes it directly to Cloudflare; do not pass values on the command line:

   ```sh
   SPICE_SECRET_STORE_ID=a436a6cefedc4acd8bb920cdbc202c1c
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name tastytrade-client-secret --scopes workers --remote
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name tastytrade-refresh-token --scopes workers --remote
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name xai --scopes workers --remote
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name account-ai-gateway --scopes workers --remote
   ```

   The existing `reddit-client-id` and `reddit-client-secret` entries are reused by name. Spice resolves the single available tastytrade account from the broker's accounts endpoint, so this deployment has no account-number secret. Secret values stay out of this repository and local files; only the deployed Worker reads them through bindings.

4. Create a Google OAuth Web client named `Spice Must Flow` with this production redirect URI:

   ```text
   https://tryspice.xyz/api/auth/callback/google
   ```

   Keep the Google app in external testing mode and add the single owner account as its test user. Add the Google credentials and Better Auth configuration to the same Secrets Store:

   ```sh
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name spice-google-client-id --scopes workers --remote
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name spice-google-client-secret --scopes workers --remote
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name spice-better-auth-secret --scopes workers --remote
   ```

   The Better Auth secret must contain at least 32 random characters. Until multi-user OAuth is configured, Google account creation is restricted to `ferdousbd@gmail.com`, and every live API route independently rechecks that session identity.
5. Push `main` to trigger the repository's native Cloudflare Workers Build (`npm run build`, then `npx wrangler deploy`). Use `npm run deploy` only as a direct manual fallback. `wrangler.jsonc` is already configured for live mode, the account-scoped market-feed Durable Object, and the New York-time guarded cron windows.

`wrangler.jsonc` binds the shared Reddit, xAI, AI Gateway, tastytrade, Google, and session-secret handles. There is intentionally no `.env`, `.env.example`, or `.dev.vars` workflow in this project; local development stays in demo mode and never needs production credentials.

Cloudflare reference: [Secrets Store bindings](https://developers.cloudflare.com/secrets-store/integrations/workers/).

Paired UTC cron windows cover both US daylight and standard time. The scheduled handler runs the daily brief only at 09:30 New York and the X catalyst workflow only at 18:30 New York on weekdays.

## Checks

```sh
npm run lint
npm test
npm run build
npm run test:e2e
```

No live order is submitted directly from chat. Dan creates a bounded draft stored in D1 with a hashed, one-time, five-minute token. Confirmation atomically claims it, resolves the exact option instrument, runs tastytrade’s dry-run endpoint, and only then submits.

The live options-metric mapping recognizes tastytrade’s REST fields for IV rank, IV percentile, IV index, and liquidity rating. One account-scoped Durable Object owns the secret-bearing tastytrade DXLink connection. Authenticated browser sessions subscribe to that relay, which unions requested symbols, streams normalized Quote, Trade, and five-minute Candle events into TanStack DB, and closes the upstream socket when the last client disconnects.

Upcoming earnings from tastytrade market metrics and material scheduled events from the Grok workflow are normalized into the D1 `catalysts` table with source, update time, confidence, and market timing. Dividend dates are deliberately excluded. TanStack DB keeps the validated calendar available offline; the story rail shows only interested symbols with a catalyst in the next 30 days, with active positions before private watchlists.

Dan refreshes a compact factual account snapshot on every turn: net liquidation value, cash and withdrawable cash, available trading funds, separate equity/derivative/day-trading buying power, positions, every leg of working ordinary and complex orders, and recent Trade transactions. Private data is provenance-tagged and the account number is never sent to the model.

Everything else is progressive and on demand. Read-only tools expose bounded account history, market metrics and hours, symbol search, active standard option contracts, exact tuple-resolved bid/ask quotes and Greeks, private/public watchlists, catalysts, and the latest daily brief. Watchlists are never part of default context. Only order placement uses the expiring confirmation state machine. An explicitly requested cancellation or private-watchlist add/remove/delete runs through its narrow server-validated tool without another confirmation step.
