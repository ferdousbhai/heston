#!/usr/bin/env bash
# Timer entry point for the local Codex catalyst refresh. It is complementary to
# the 09:30 New York Worker job: this run writes only codex_web_catalysts, and the
# Worker reads whatever fresh rows exist. Any failure here (laptop closed, offline,
# Codex or Wrangler error) leaves X, Reddit, and the Daily Brief untouched.
set -euo pipefail

cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.."

runs_root='ops/catalyst-research/runs/daily'
# One directory per New York day: chunks are resumable, so a run interrupted by
# suspend picks up where it stopped when the timer's Persistent catch-up fires.
run_dir="$runs_root/$(TZ=America/New_York date +%Y-%m-%d)"
applied_marker="$run_dir/applied-at"

# Cooldown. Scheduled catalysts move on the order of days and the 09:30 New York
# job accepts codex_web_catalysts rows re-verified within seven days, so one
# applied run per New York day is the refresh rate the product needs; a second
# run in the same day re-spends a ~45 minute Codex pass to upsert identical rows.
# The window is the New York day rather than an elapsed 24 hours because
# consecutive timer fires are themselves 24 hours apart: measured from the last
# run, the next fire always lands just under the window and would be skipped,
# leaving the job running every other weekday. Set SPICE_CATALYST_FORCE to
# refresh again within the same day.
if [[ -f "$applied_marker" && -z "${SPICE_CATALYST_FORCE:-}" ]]; then
  echo "Catalyst refresh already applied for ${run_dir##*/} at $(cat "$applied_marker"); skipping."
  exit 0
fi

mkdir -p "$runs_root"
find "$runs_root" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +

SPICE_CATALYST_MODE=apply SPICE_CATALYST_RUN_DIR="$run_dir" bash ops/catalyst-research/run.sh
# Only a completed apply opens the cooldown; a failed run leaves no marker so the
# next fire retries the day.
date -u +%Y-%m-%dT%H:%M:%SZ >"$applied_marker"
