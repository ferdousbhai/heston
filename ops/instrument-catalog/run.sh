#!/usr/bin/env bash
set -euo pipefail

source ops/shared/temporary-worker.sh

ops_worker="$(temporary_worker_name 'spice-instrument-catalog')"
ops_mode="${SPICE_CATALOG_MODE:-preview}"

if [[ "$ops_mode" != 'preview' && "$ops_mode" != 'apply' ]]; then
  echo 'SPICE_CATALOG_MODE must be preview or apply.' >&2
  exit 2
fi

trap temporary_worker_cleanup_on_exit EXIT
temporary_worker_start "$ops_worker" ops/instrument-catalog/wrangler.jsonc

catalog_offset=0
while true; do
  catalog_result="$(temporary_worker_call "$ops_mode?offset=$catalog_offset")"
  printf '%s\n' "$catalog_result"
  catalog_complete="$(node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => process.stdout.write(String(JSON.parse(input).result.complete)));
  ' <<<"$catalog_result")"
  if [[ "$catalog_complete" == 'true' ]]; then
    if [[ "$ops_mode" == 'apply' ]]; then
      temporary_worker_call finalize
      temporary_worker_call sync
    fi
    exit 0
  fi
  next_catalog_offset="$(node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => process.stdout.write(String(JSON.parse(input).result.nextOffset)));
  ' <<<"$catalog_result")"
  if [[ ! "$next_catalog_offset" =~ ^[0-9]+$ ]] || (( next_catalog_offset <= catalog_offset )); then
    echo 'Instrument catalog returned a non-advancing offset.' >&2
    exit 1
  fi
  catalog_offset="$next_catalog_offset"
done
