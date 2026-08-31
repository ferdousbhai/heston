#!/usr/bin/env bash

# Cloudflare Worker names are limited to 63 characters. Prefixes remain explicit
# at each product entrypoint; the timestamp and random suffix prevent overlapping
# manual, timer, and nested bootstrap runs from sharing a deployment.
readonly TEMPORARY_WORKER_MAX_NAME_LENGTH=63

# Cloudflare's control plane returns transient 5xx on deploys: a 503 on the
# deployments endpoint aborted the 2026-08-28 catalyst run eight seconds in and cost
# that day's research. Three attempts ten seconds apart bound the added delay to ~20s
# against callers that already allow hours, while covering a blip that clears in
# seconds. Deletion in temporary_worker_stop stays unretried on purpose: an orphaned
# Worker must be reported, never hidden behind repeated cleanup.
temporary_worker_api_attempts="${TEMPORARY_WORKER_API_ATTEMPTS:-3}"
temporary_worker_retry_delay_seconds="${TEMPORARY_WORKER_RETRY_DELAY_SECONDS:-10}"

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

# Runs one Wrangler step into the shared log, retrying the transport. `mode` is
# truncate for the deploy, whose output the URL reader parses, and append for later
# steps that must not erase it. Any redirection a step needs belongs inside the step's
# own function so each attempt re-opens it: a redirect applied here would leave the
# second attempt reading an exhausted descriptor.
temporary_worker_api_retry() {
  local mode="$1"
  local description="$2"
  shift 2
  local attempt=1
  while true; do
    if [[ "$mode" == 'truncate' ]]; then
      if "$@" >"$temporary_worker_log" 2>&1; then return 0; fi
    else
      if "$@" >>"$temporary_worker_log" 2>&1; then return 0; fi
    fi
    if (( attempt >= temporary_worker_api_attempts )); then
      cat "$temporary_worker_log" >&2
      echo "$description failed after $attempt attempts: $temporary_worker_name_value" >&2
      return 1
    fi
    echo "$description attempt $attempt failed; retrying in ${temporary_worker_retry_delay_seconds}s" >&2
    attempt=$(( attempt + 1 ))
    sleep "$temporary_worker_retry_delay_seconds"
  done
}

temporary_worker_deploy_step() {
  npx wrangler deploy --config "$1" --name "$2"
}

temporary_worker_token_step() {
  npx wrangler secret put OPS_AUTH_TOKEN --name "$1" <"$temporary_worker_secret"
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

  if ! temporary_worker_api_retry truncate 'Temporary Worker deploy' \
    temporary_worker_deploy_step "$config_path" "$worker_name"; then
    return 1
  fi
  temporary_worker_deployed='true'

  if ! temporary_worker_api_retry append 'Temporary Worker token install' \
    temporary_worker_token_step "$worker_name"; then
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
