#!/usr/bin/env bash
set -euo pipefail

ops_worker='spice-research-focus-publish-20260826'
ops_log="$(mktemp)"
ops_secret="$(mktemp)"
ops_deployed='false'

cleanup() {
  if [[ "$ops_deployed" == 'true' ]]; then
    npx wrangler delete "$ops_worker" --force >/dev/null 2>&1 || true
  fi
  rm -f "$ops_log" "$ops_secret"
}
trap cleanup EXIT

chmod 600 "$ops_secret"
openssl rand -hex 32 >"$ops_secret"
npx wrangler deploy --config ops/research-focus/wrangler.jsonc >"$ops_log" 2>&1
ops_deployed='true'
npx wrangler secret put OPS_AUTH_TOKEN --name "$ops_worker" <"$ops_secret" >>"$ops_log" 2>&1

ops_url="$(sed -n 's/.*\(https:\/\/[^ ]*\.workers\.dev\).*/\1/p' "$ops_log" | tail -n 1)"
if [[ -z "$ops_url" ]]; then
  cat "$ops_log" >&2
  echo 'Wrangler did not report the temporary Worker URL.' >&2
  exit 1
fi

node ops/shared/call-worker.mjs "$ops_secret" "$ops_url" apply
