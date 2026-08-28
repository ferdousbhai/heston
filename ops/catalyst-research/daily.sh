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
mkdir -p "$runs_root"
find "$runs_root" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +

SPICE_CATALYST_MODE=apply SPICE_CATALYST_RUN_DIR="$run_dir" bash ops/catalyst-research/run.sh
