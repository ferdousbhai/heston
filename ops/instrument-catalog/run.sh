#!/usr/bin/env bash
set -euo pipefail

source ops/shared/temporary-worker.sh

ops_worker="$(temporary_worker_name 'heston-instrument-catalog')"
ops_mode="${HESTON_CATALOG_MODE:-preview}"

if [[ "$ops_mode" != 'preview' && "$ops_mode" != 'apply' ]]; then
  echo 'HESTON_CATALOG_MODE must be preview or apply.' >&2
  exit 2
fi

trap temporary_worker_cleanup_on_exit EXIT
temporary_worker_start "$ops_worker" ops/instrument-catalog/wrangler.jsonc

catalog_field() {
  node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => process.stdout.write(String(JSON.parse(input).result[process.argv[1]])));
  ' "$1"
}

catalog_offset=0
while true; do
  catalog_result="$(temporary_worker_call "$ops_mode?offset=$catalog_offset")"
  printf '%s\n' "$catalog_result"
  catalog_complete="$(catalog_field complete <<<"$catalog_result")"
  if [[ "$catalog_complete" == 'true' ]]; then
    if [[ "$ops_mode" == 'apply' ]]; then
      temporary_worker_call finalize
      temporary_worker_call sync
    fi
    exit 0
  fi
  next_catalog_offset="$(catalog_field nextOffset <<<"$catalog_result")"
  if [[ ! "$next_catalog_offset" =~ ^[0-9]+$ ]] || (( next_catalog_offset <= catalog_offset )); then
    echo 'Instrument catalog returned a non-advancing offset.' >&2
    exit 1
  fi
  catalog_offset="$next_catalog_offset"
done
