#!/usr/bin/env bash
set -euo pipefail

ops_worker='spice-catalyst-research-bootstrap-20260826'
ops_mode="${SPICE_CATALYST_MODE:-preview}"
ops_log="$(mktemp)"
ops_secret="$(mktemp)"
ops_input="$(mktemp)"
ops_deployed='false'
ops_run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
ops_runs_dir="${SPICE_CATALYST_RUN_DIR:-ops/catalyst-research/runs/$ops_run_stamp}"
ops_artifact="${SPICE_CATALYST_ARTIFACT:-$ops_runs_dir/artifact.json}"

if [[ "$ops_mode" != 'input' && "$ops_mode" != 'preview' && "$ops_mode" != 'apply' ]]; then
  echo 'SPICE_CATALYST_MODE must be input, preview, or apply.' >&2
  exit 2
fi

cleanup() {
  if [[ "$ops_deployed" == 'true' ]]; then
    npx wrangler delete "$ops_worker" --force >/dev/null 2>&1 || true
  fi
  rm -f "$ops_log" "$ops_secret" "$ops_input"
}
trap cleanup EXIT

chmod 600 "$ops_secret"
openssl rand -hex 32 >"$ops_secret"
mkdir -p "$ops_runs_dir"

npx wrangler deploy --config ops/catalyst-research/wrangler.jsonc >"$ops_log" 2>&1
ops_deployed='true'
npx wrangler secret put OPS_AUTH_TOKEN --name "$ops_worker" <"$ops_secret" >>"$ops_log" 2>&1

ops_url="$(sed -n 's/.*\(https:\/\/[^ ]*\.workers\.dev\).*/\1/p' "$ops_log" | tail -n 1)"
if [[ -z "$ops_url" ]]; then
  cat "$ops_log" >&2
  echo 'Wrangler did not report the temporary Worker URL.' >&2
  exit 1
fi

node ops/shared/call-worker.mjs "$ops_secret" "$ops_url" input >"$ops_input"
if [[ "$ops_mode" == 'input' ]]; then
  cp "$ops_input" "$ops_runs_dir/input.json"
  echo "Input: $ops_runs_dir/input.json"
  exit 0
fi
if [[ -z "${SPICE_CATALYST_ARTIFACT:-}" ]]; then
  node ops/catalyst-research/run-codex.mjs "$ops_input" "$ops_artifact" "$ops_runs_dir"
fi

node ops/shared/call-worker.mjs "$ops_secret" "$ops_url" validate "$ops_artifact"
if [[ "$ops_mode" == 'apply' ]]; then
  node ops/shared/call-worker.mjs "$ops_secret" "$ops_url" apply "$ops_artifact"
fi
echo "Artifact: $ops_artifact"
