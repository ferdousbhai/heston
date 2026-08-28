#!/usr/bin/env bash
# Build, serve the production bundle locally behind a compressing proxy, and report the
# median time-to-first-table-row on a throttled mobile profile with fixed API latency.
#   bash tools/perf/bench.sh [runs] [snapshot.json]
set -euo pipefail
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../.."
runs="${1:-5}"
snapshot="${2:-tools/perf/snapshot.fixture.json}"
preview_port=4173
proxy_port=4174
npm run build >/dev/null 2>&1
npm run preview -- --port "$preview_port" >/dev/null 2>&1 &
preview_pid=$!
trap 'kill "$preview_pid" 2>/dev/null || true' EXIT
preview_ready=false
for _ in $(seq 1 120); do
  if curl -sf -o /dev/null "http://localhost:$preview_port/"; then
    preview_ready=true
    break
  fi
  kill -0 "$preview_pid" 2>/dev/null || break
  sleep 0.25
done
if [[ "$preview_ready" == true ]]; then
  PERF_COMPRESS_UPSTREAM="http://localhost:$preview_port" node tools/perf/measure.mjs "http://localhost:$proxy_port/" "$runs" throttle "mock=$snapshot"
else
  # Restricted sandboxes may deny every TCP listener. Playwright can still serve the exact
  # built Worker document and Brotli client assets through request interception.
  wait "$preview_pid" 2>/dev/null || true
  PERF_STATIC_ROOT="dist/client" PERF_SERVER_ENTRY="dist/server/index.js" node tools/perf/measure.mjs "http://localhost:$proxy_port/" "$runs" throttle "mock=$snapshot"
fi
