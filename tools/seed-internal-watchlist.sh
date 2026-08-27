#!/usr/bin/env bash
set -euo pipefail

seed_worker='spice-watchlist-bootstrap-20260826'
seed_mode="${SPICE_SEED_MODE:-bootstrap}"
seed_log="$(mktemp)"
seed_secret="$(mktemp)"
seed_deployed='false'

if [[ "$seed_mode" != 'preview' && "$seed_mode" != 'sync' && "$seed_mode" != 'bootstrap' ]]; then
  echo 'SPICE_SEED_MODE must be preview, sync, or bootstrap.' >&2
  exit 2
fi

cleanup() {
  if [[ "$seed_deployed" == 'true' ]]; then
    npx wrangler delete "$seed_worker" --force >/dev/null 2>&1 || true
  fi
  rm -f "$seed_log" "$seed_secret"
}
trap cleanup EXIT

chmod 600 "$seed_secret"
openssl rand -hex 32 >"$seed_secret"

npx wrangler deploy --config tools/wrangler.seed.jsonc >"$seed_log" 2>&1
seed_deployed='true'

npx wrangler secret put OPS_AUTH_TOKEN --name "$seed_worker" <"$seed_secret" >>"$seed_log" 2>&1

seed_url="$(sed -n 's/.*\(https:\/\/[^ ]*\.workers\.dev\).*/\1/p' "$seed_log" | tail -n 1)"
if [[ -z "$seed_url" ]]; then
  cat "$seed_log" >&2
  echo 'The bootstrap Worker deployed, but Wrangler did not report its workers.dev URL.' >&2
  exit 1
fi

call_seed_worker() {
  node ops/shared/call-worker.mjs "$seed_secret" "$seed_url" "$1"
}

if [[ "$seed_mode" == 'bootstrap' ]]; then
  # The authoritative list is not ready for product use until the retained
  # provenance has been resolved, reduced to 100 names, published, and synced.
  seed_result="$(call_seed_worker seed)"
  printf '%s\n' "$seed_result"
  seed_finalized="$(node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => process.stdout.write(String(Boolean(JSON.parse(input).audit.finalizedAt))));
  ' <<<"$seed_result")"
  if [[ "$seed_finalized" == 'true' ]]; then
    # Finalization and the first owner snapshot are separate invocations so each
    # stays within D1 limits. A retry must repair an interrupted post-finalize sync.
    call_seed_worker sync
    exit 0
  fi
  SPICE_CATALOG_MODE=apply bash ops/instrument-catalog/run.sh
else
  call_seed_worker "$seed_mode"
fi
