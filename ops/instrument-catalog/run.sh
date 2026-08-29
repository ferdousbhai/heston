#!/usr/bin/env bash
set -euo pipefail

ops_worker='spice-instrument-catalog-bootstrap-20260826'
ops_mode="${SPICE_CATALOG_MODE:-preview}"
ops_log="$(mktemp)"
ops_secret="$(mktemp)"
ops_deployed='false'

if [[ "$ops_mode" != 'preview' && "$ops_mode" != 'apply' ]]; then
  echo 'SPICE_CATALOG_MODE must be preview or apply.' >&2
  exit 2
fi

cleanup() {
  if [[ "$ops_deployed" == 'true' ]]; then
    npx wrangler delete "$ops_worker" --force >/dev/null 2>&1 || true
  fi
  rm -f "$ops_log" "$ops_secret"
}
trap cleanup EXIT

chmod 600 "$ops_secret"
openssl rand -hex 32 >"$ops_secret"

npx wrangler deploy --config ops/instrument-catalog/wrangler.jsonc >"$ops_log" 2>&1
ops_deployed='true'
npx wrangler secret put OPS_AUTH_TOKEN --name "$ops_worker" <"$ops_secret" >>"$ops_log" 2>&1

ops_url="$(sed -n 's/.*\(https:\/\/[^ ]*\.workers\.dev\).*/\1/p' "$ops_log" | tail -n 1)"
if [[ -z "$ops_url" ]]; then
  cat "$ops_log" >&2
  echo 'Wrangler did not report the temporary Worker URL.' >&2
  exit 1
fi

catalog_offset=0
while true; do
  catalog_result="$(node ops/shared/call-worker.mjs "$ops_secret" "$ops_url" "$ops_mode?offset=$catalog_offset")"
  printf '%s\n' "$catalog_result"
  catalog_complete="$(node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => process.stdout.write(String(JSON.parse(input).result.complete)));
  ' <<<"$catalog_result")"
  if [[ "$catalog_complete" == 'true' ]]; then
    if [[ "$ops_mode" == 'apply' ]]; then
      node ops/shared/call-worker.mjs "$ops_secret" "$ops_url" finalize
      node ops/shared/call-worker.mjs "$ops_secret" "$ops_url" sync
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
