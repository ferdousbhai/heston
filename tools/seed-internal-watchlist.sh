#!/usr/bin/env bash
set -euo pipefail

seed_worker='spice-watchlist-bootstrap-20260826'
seed_mode="${SPICE_SEED_MODE:-seed}"
seed_log="$(mktemp)"
seed_secret="$(mktemp)"
seed_deployed='false'

if [[ "$seed_mode" != 'preview' && "$seed_mode" != 'seed' && "$seed_mode" != 'sync' ]]; then
  echo 'SPICE_SEED_MODE must be preview, seed, or sync.' >&2
  exit 2
fi

cleanup() {
  if [[ "$seed_deployed" == 'true' ]]; then
    npx wrangler delete "$seed_worker" --force >/dev/null 2>&1 || true
  fi
  rm -f "$seed_log" "$seed_secret"
}
trap cleanup EXIT

chmod 600 "$seed_secret"
openssl rand -hex 32 >"$seed_secret"

npx wrangler deploy --config tools/wrangler.seed.jsonc >"$seed_log" 2>&1
seed_deployed='true'

npx wrangler secret put SEED_AUTH_TOKEN --name "$seed_worker" <"$seed_secret" >>"$seed_log" 2>&1

seed_url="$(sed -n 's/.*\(https:\/\/[^ ]*\.workers\.dev\).*/\1/p' "$seed_log" | tail -n 1)"
if [[ -z "$seed_url" ]]; then
  cat "$seed_log" >&2
  echo 'The bootstrap Worker deployed, but Wrangler did not report its workers.dev URL.' >&2
  exit 1
fi

node -e '
  const fs = require("node:fs");
  const token = fs.readFileSync(process.argv[1], "utf8").trim();
  (async () => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await fetch(`${process.argv[2]}/${process.argv[3]}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.text();
      if (response.status === 404 && attempt < 29) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        continue;
      }
      if (!response.ok) throw new Error(body);
      console.log(JSON.stringify(JSON.parse(body), null, 2));
      return;
    }
  })().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
' "$seed_secret" "$seed_url" "$seed_mode"
