# Spice Must Flow

Spice Must Flow is a mobile-first options intelligence app: Apple Stocks-style market scanning, editorial daily research, local-first TanStack DB state, tastytrade account context, and a confirmation-gated trading agent.

The daily issue combines live tastytrade option metrics with bounded Federal Reserve, SEC, and authenticated Reddit feeds. Workers AI may synthesize the evidence, but the application attaches source links itself so generated URLs are never trusted.

## Run it

```sh
npm install
npm run dev
```

The repository defaults to `APP_MODE=demo`, so the complete interface works without credentials. Demo confirmations never call a brokerage.

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
   ```

   The existing `reddit-client-id` and `reddit-client-secret` entries are reused by name. Secret values cannot be read back by Spice, Wrangler, or this repository.

4. Put the Worker behind Cloudflare Access, then add its verifier settings to the same Secrets Store:

   ```sh
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name spice-access-team-domain --scopes workers --remote
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name spice-access-aud --scopes workers --remote
   npx wrangler secrets-store secret create "$SPICE_SECRET_STORE_ID" --name spice-access-email --scopes workers --remote
   ```

   Live API routes verify the Access JWT signature, issuer, application audience, and your exact email. A forwarded identity header alone is deliberately insufficient.
5. Change `APP_MODE` to `live`, then deploy with `npm run deploy`.

`wrangler.jsonc` binds the shared Reddit and tastytrade Secret Store handles. Add the three Access handles after creating them, then change `APP_MODE` to `live`. There is intentionally no `.env`, `.env.example`, or `.dev.vars` workflow in this project; local development stays in demo mode and never needs production credentials.

Cloudflare reference: [Secrets Store bindings](https://developers.cloudflare.com/secrets-store/integrations/workers/).

The two UTC cron invocations cover both US daylight and standard time. The scheduled handler runs only when the local New York time is exactly 09:30 on a weekday.

## Checks

```sh
npm test
npm run build
npm run test:e2e
```

No live order is submitted directly from chat. Dan creates a bounded draft stored in D1 with a hashed, one-time, five-minute token. Confirmation atomically claims it, resolves the exact option instrument, runs tastytrade’s dry-run endpoint, and only then submits.

The live options metrics use the fields actually supplied by tastytrade’s REST API: IV rank, IV percentile, IV index, and liquidity rating. The app never fills unsupported live fields with demo estimates. The compact live price trace is previous close to current price; full candle history belongs behind a future DXLink stream rather than a fabricated chart.

Upcoming earnings and dividend dates are normalized from tastytrade market metrics into the D1 `catalysts` table with source, update time, confidence, and market timing. TanStack DB keeps the validated calendar available offline, and watchlists order symbols by their nearest upcoming catalyst while preserving their original order for symbols without one.
