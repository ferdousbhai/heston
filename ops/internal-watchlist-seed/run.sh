#!/usr/bin/env bash
set -euo pipefail

source ops/shared/temporary-worker.sh

seed_worker="$(temporary_worker_name 'heston-watchlist-bootstrap')"
seed_mode="${HESTON_SEED_MODE:-bootstrap}"

if [[ "$seed_mode" != 'preview' && "$seed_mode" != 'sync' && "$seed_mode" != 'bootstrap' ]]; then
  echo 'HESTON_SEED_MODE must be preview, sync, or bootstrap.' >&2
  exit 2
fi

trap temporary_worker_cleanup_on_exit EXIT
temporary_worker_start "$seed_worker" ops/internal-watchlist-seed/wrangler.jsonc

if [[ "$seed_mode" == 'bootstrap' ]]; then
  # The authoritative list is not ready for product use until the retained
  # provenance has been resolved, reduced to 100 names, published, and synced.
  seed_result="$(temporary_worker_call seed)"
  printf '%s\n' "$seed_result"
  seed_finalized="$(node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => process.stdout.write(String(Boolean(JSON.parse(input).audit.finalizedAt))));
  ' <<<"$seed_result")"
  if [[ "$seed_finalized" == 'true' ]]; then
    # Finalization and the first owner snapshot are separate invocations so each
    # stays within D1 limits. A retry must repair an interrupted post-finalize sync.
    temporary_worker_call sync
    exit 0
  fi
  HESTON_CATALOG_MODE=apply bash ops/instrument-catalog/run.sh
else
  temporary_worker_call "$seed_mode"
fi
