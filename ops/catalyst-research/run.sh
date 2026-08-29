#!/usr/bin/env bash
set -euo pipefail

source ops/shared/temporary-worker.sh

ops_input_worker="$(temporary_worker_name 'spice-catalyst-input')"
ops_output_worker="$(temporary_worker_name 'spice-catalyst-output')"
ops_mode="${SPICE_CATALYST_MODE:-preview}"
ops_input="$(mktemp)"
ops_run_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
ops_runs_dir="${SPICE_CATALYST_RUN_DIR:-ops/catalyst-research/runs/$ops_run_stamp}"
ops_artifact="${SPICE_CATALYST_ARTIFACT:-$ops_runs_dir/artifact.json}"

cleanup() {
  local original_status=$?
  rm -f "$ops_input"
  temporary_worker_exit_with_cleanup "$original_status"
}
trap cleanup EXIT

if [[ "$ops_mode" != 'input' && "$ops_mode" != 'preview' && "$ops_mode" != 'apply' ]]; then
  echo 'SPICE_CATALYST_MODE must be input, preview, or apply.' >&2
  exit 2
fi

mkdir -p "$ops_runs_dir"
temporary_worker_start "$ops_input_worker" ops/catalyst-research/wrangler.jsonc

temporary_worker_call input >"$ops_input"
temporary_worker_stop
if [[ "$ops_mode" == 'input' ]]; then
  cp "$ops_input" "$ops_runs_dir/input.json"
  echo "Input: $ops_runs_dir/input.json"
  exit 0
fi
if [[ -z "${SPICE_CATALYST_ARTIFACT:-}" ]]; then
  node ops/catalyst-research/run-codex.mjs "$ops_input" "$ops_artifact" "$ops_runs_dir"
fi

temporary_worker_start "$ops_output_worker" ops/catalyst-research/wrangler.jsonc
if [[ "$ops_mode" == 'apply' ]]; then
  temporary_worker_call apply "$ops_artifact"
else
  temporary_worker_call validate "$ops_artifact"
fi
echo "Artifact: $ops_artifact"
