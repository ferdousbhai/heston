#!/usr/bin/env bash

# Cloudflare Worker names are limited to 63 characters. Prefixes remain explicit
# at each product entrypoint; the timestamp and random suffix prevent overlapping
# manual, timer, and nested bootstrap runs from sharing a deployment.
readonly TEMPORARY_WORKER_MAX_NAME_LENGTH=63

temporary_worker_deployed='false'
temporary_worker_name_value=''
temporary_worker_log=''
temporary_worker_secret=''
temporary_worker_url=''

temporary_worker_name() {
  local prefix="$1"
  local stamp suffix candidate
  stamp="$(date -u +%Y%m%dt%H%M%Sz)"
  suffix="$(openssl rand -hex 4)"
  candidate="${prefix}-${stamp}-${suffix}"
  if (( ${#candidate} > TEMPORARY_WORKER_MAX_NAME_LENGTH )); then
    echo "Temporary Worker name exceeds Cloudflare's ${TEMPORARY_WORKER_MAX_NAME_LENGTH}-character limit: $candidate" >&2
    return 1
  fi
  if [[ ! "$candidate" =~ ^[a-z0-9][a-z0-9-]*[a-z0-9]$ ]]; then
    echo "Invalid temporary Worker name: $candidate" >&2
    return 1
  fi
  printf '%s\n' "$candidate"
}

temporary_worker_release_local_files() {
  [[ -z "$temporary_worker_log" ]] || rm -f "$temporary_worker_log"
  [[ -z "$temporary_worker_secret" ]] || rm -f "$temporary_worker_secret"
  temporary_worker_log=''
  temporary_worker_secret=''
  temporary_worker_url=''
}

temporary_worker_start() {
  local worker_name="$1"
  local config_path="$2"
  if [[ "$temporary_worker_deployed" == 'true' ]]; then
    echo "Temporary Worker is already deployed: $temporary_worker_name_value" >&2
    return 1
  fi

  temporary_worker_name_value="$worker_name"
  temporary_worker_log="$(mktemp)"
  temporary_worker_secret="$(mktemp)"
  chmod 600 "$temporary_worker_secret"
  openssl rand -hex 32 >"$temporary_worker_secret"

  if ! npx wrangler deploy --config "$config_path" --name "$worker_name" >"$temporary_worker_log" 2>&1; then
    cat "$temporary_worker_log" >&2
    echo "Failed to deploy temporary Worker: $worker_name" >&2
    return 1
  fi
  temporary_worker_deployed='true'

  if ! npx wrangler secret put OPS_AUTH_TOKEN --name "$worker_name" <"$temporary_worker_secret" >>"$temporary_worker_log" 2>&1; then
    cat "$temporary_worker_log" >&2
    echo "Failed to install the temporary Worker token: $worker_name" >&2
    return 1
  fi

  if ! temporary_worker_url="$(node ops/shared/temporary-worker-url.mjs "$temporary_worker_log" "$worker_name")"; then
    cat "$temporary_worker_log" >&2
    return 1
  fi
}

temporary_worker_call() {
  local endpoint="$1"
  local body_path="${2:-}"
  if [[ "$temporary_worker_deployed" != 'true'
    || -z "$temporary_worker_secret"
    || -z "$temporary_worker_url" ]]; then
    echo 'Temporary Worker is not ready.' >&2
    return 1
  fi
  if [[ -n "$body_path" ]]; then
    node ops/shared/call-worker.mjs "$temporary_worker_secret" "$temporary_worker_url" "$endpoint" "$body_path"
  else
    node ops/shared/call-worker.mjs "$temporary_worker_secret" "$temporary_worker_url" "$endpoint"
  fi
}

temporary_worker_stop() {
  local delete_output=''
  local delete_status=0
  if [[ "$temporary_worker_deployed" == 'true' ]]; then
    if ! delete_output="$(npx wrangler delete "$temporary_worker_name_value" --force 2>&1)"; then
      echo "Failed to delete temporary Worker: $temporary_worker_name_value" >&2
      printf '%s\n' "$delete_output" >&2
      delete_status=1
    fi
  fi
  # Do not hide a failed deletion behind repeated cleanup attempts. The exact
  # orphan name was emitted above so an owner can remove it deliberately.
  temporary_worker_deployed='false'
  temporary_worker_release_local_files
  return "$delete_status"
}

temporary_worker_exit_with_cleanup() {
  local original_status="$1"
  local cleanup_status=0
  trap - EXIT
  temporary_worker_stop || cleanup_status=$?
  if (( original_status != 0 )); then
    exit "$original_status"
  fi
  exit "$cleanup_status"
}

temporary_worker_cleanup_on_exit() {
  local original_status=$?
  temporary_worker_exit_with_cleanup "$original_status"
}
