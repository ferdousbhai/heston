#!/usr/bin/env bash
# Store the credentials the local proxy needs, in the OS keyring.
#
# `secret-tool store` prompts for the value itself and reads it from the terminal, so nothing
# here reaches your shell history, the process argument list, or any file. That is the whole
# reason the proxy reads the keyring rather than an env file: a value in the environment is
# readable by any tool the agent can run, and a tastytrade refresh token never expires.
set -euo pipefail


usage() {
  cat <<'EOF'
Usage: store-credentials.sh [mcp-token|tastytrade|all]

  mcp-token   The Spice agent token, created in the web app's Connect tab.
  tastytrade  A personal grant instead of Spice's tastytrade app: the client
              secret and refresh token from my.tastytrade.com > OAuth
              Applications > Manage > Create Grant. The read and trade scopes
              need two-factor auth on your account.
  all         Both (default).

Each value is prompted for; nothing is passed on the command line.

To connect tastytrade the usual way -- approve Spice on tastytrade's own page,
with no client secret to copy -- store the Spice token, then run:

  ./ops/spice-agent/connect-tastytrade.mjs

Keep one kind of tastytrade credential: the proxy refuses to start with both.
EOF
}

# Filed under the service that issued the credential, not the app that spends it, so a second
# broker becomes its own service rather than more keys under Spice's. The label is only what
# Seahorse displays; the service and key attributes are what the proxy looks up.
store() {
  local service=$1 key=$2 label=$3 prompt=$4
  printf '\n%s\n' "${prompt}"
  secret-tool store --label="${label}" service "${service}" key "${key}"
  if [[ -z $(secret-tool lookup service "${service}" key "${key}" 2>/dev/null) ]]; then
    echo "  failed to store ${service}/${key}" >&2
    exit 1
  fi
  echo "  stored ${service}/${key}"
}

command -v secret-tool >/dev/null || { echo 'secret-tool is not installed (package: libsecret).' >&2; exit 1; }

case "${1:-all}" in
  mcp-token) want_mcp=1; want_tasty=0 ;;
  tastytrade) want_mcp=0; want_tasty=1 ;;
  all) want_mcp=1; want_tasty=1 ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 1 ;;
esac

if [[ ${want_mcp} -eq 1 ]]; then
  store spice mcp-token 'Spice agent token' 'Spice agent token (Connect tab in the web app):'
fi

if [[ ${want_tasty} -eq 1 ]]; then
  store tastytrade client-secret 'tastytrade OAuth client secret' 'tastytrade OAuth client secret:'
  store tastytrade refresh-token 'tastytrade refresh token' 'tastytrade refresh token (the grant you created):'
fi

# The proxy reads the keyring once at startup, so it has to be restarted to see a new value.
if systemctl --user is-enabled spice-agent-proxy.service >/dev/null 2>&1; then
  systemctl --user restart spice-agent-proxy.service
  echo
  systemctl --user is-active spice-agent-proxy.service >/dev/null \
    && echo 'Proxy restarted. Check what it picked up with:' \
    || echo 'Proxy failed to restart; check:'
  echo '  journalctl --user -u spice-agent-proxy.service -n 5'
else
  echo
  echo 'Proxy service is not installed. Enable it with:'
  echo '  cp ops/spice-agent/systemd/spice-agent-proxy.service ~/.config/systemd/user/'
  echo '  systemctl --user daemon-reload && systemctl --user enable --now spice-agent-proxy.service'
fi
