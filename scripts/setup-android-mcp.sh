#!/usr/bin/env bash
# Manage the Android Remote Control MCP connectors with tokens kept in 1Password.
#
# Each device has one 1Password item, agent-configs-android-mcp-<slug>, with a
# "credential" field in the shared "Agent Configs" vault. This script moves a
# token between 1Password, a USB-attached device (adb) and the Claude Code user
# config. Token values are never printed. See docs/android-mcp.md.
set -euo pipefail
umask 077

VAULT="${AGENT_CONFIGS_OP_VAULT:-Agent Configs}"
APP_ID="com.danielealbano.androidremotecontrolmcp"
ADB_ACTION="${APP_ID}.ADB_CONFIGURE"
ADB_RECEIVER="${APP_ID}/${APP_ID}.services.mcp.AdbConfigReceiver"
ADB_TRAMPOLINE="${APP_ID}/${APP_ID}.services.mcp.AdbServiceTrampolineActivity"
CLAUDE_CONFIG="${HOME}/.claude.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# connector name | device slug | tailnet host (the app serves MCP on port 8080)
DEVICES=(
  "android-beam-pro|beam-pro|beam-pro.capybara-ulmer.ts.net"
  "android-beam-pro-1|beam-pro-1|beam-pro-1.capybara-ulmer.ts.net"
  "android-tab-s8-ultra|tab-s8-ultra|liams-tab-s8-ultra.capybara-ulmer.ts.net"
  "android-tab-s9-ultra|tab-s9-ultra|galaxy-tab-s9-ultra.capybara-ulmer.ts.net"
)

usage() {
  cat <<'EOF'
Manage the Android Remote Control MCP connectors with tokens from 1Password.

Usage:
  ./scripts/setup-android-mcp.sh status
  ./scripts/setup-android-mcp.sh store SLUG (--generate | --paste)
  ./scripts/setup-android-mcp.sh install [--device SLUG]... [--apply]
  ./scripts/setup-android-mcp.sh verify [--device SLUG]... [--serial ADB_SERIAL]
  ./scripts/setup-android-mcp.sh provision SLUG --serial ADB_SERIAL [--start] [--apply]

Commands:
  status     Read-only: 1Password item and Claude Code connector per device.
  store      Save a device token in 1Password. --generate creates a new UUID;
             --paste reads one with echo off (copy it from the app's Server tab).
  install    Register each connector in Claude Code (user scope) with its token
             from 1Password. Prints a plan unless --apply is given.
  verify     Send an authenticated ping and print HTTP codes. Uses each tailnet URL,
             or USB with --serial (needs exactly one --device).
  provision  Set the token on a USB-attached device over adb. Prints a plan
             unless --apply is given. --start also starts the MCP server.

Slugs: beam-pro, beam-pro-1, tab-s8-ultra, tab-s9-ultra.
Token values are never printed.
EOF
}

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 was not found on PATH"
}

require_op() {
  need op
  op vault list --format=json >/dev/null 2>&1 || fail "1Password CLI cannot list vaults; unlock the 1Password app (desktop integration) or run: op signin"
}

parse_entry() {  # sets DEV_NAME, DEV_SLUG, DEV_HOST from a DEVICES entry
  IFS='|' read -r DEV_NAME DEV_SLUG DEV_HOST <<<"$1"
}

find_device() {  # sets DEV_NAME, DEV_SLUG, DEV_HOST and ITEM for slug $1
  local entry
  for entry in "${DEVICES[@]}"; do
    parse_entry "$entry"
    if [[ "$DEV_SLUG" == "$1" ]]; then
      ITEM="agent-configs-android-mcp-${DEV_SLUG}"
      return 0
    fi
  done
  fail "unknown device slug '$1' (use: beam-pro, beam-pro-1, tab-s8-ultra, tab-s9-ultra)"
}

selected() {  # true when no --device was given, or slug $1 was given
  local slug
  if ((${#SELECTED[@]} == 0)); then
    return 0
  fi
  for slug in "${SELECTED[@]}"; do
    [[ "$slug" == "$1" ]] && return 0
  done
  return 1
}

validate_selection() {
  local slug
  for slug in "${SELECTED[@]+"${SELECTED[@]}"}"; do
    find_device "$slug"
  done
}

item_exists() {
  op item get "$1" --vault "$VAULT" --format=json >/dev/null 2>&1
}

read_token() {
  op read "op://${VAULT}/${1}/credential"
}

check_token() {  # $1 token, $2 item name (for the message only)
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] || fail "token in $2 is empty or has unexpected characters"
}

claude_registered() {
  [[ -f "$CLAUDE_CONFIG" ]] && jq -e --arg n "$1" '.mcpServers[$n] != null' "$CLAUDE_CONFIG" >/dev/null 2>&1
}

cmd_status() {
  local entry state_op state_claude
  require_op
  need jq
  printf '%-20s %-10s %-11s %s\n' CONNECTOR 1PASSWORD CLAUDE URL
  for entry in "${DEVICES[@]}"; do
    parse_entry "$entry"
    ITEM="agent-configs-android-mcp-${DEV_SLUG}"
    state_op=missing
    state_claude=missing
    item_exists "$ITEM" && state_op=present
    claude_registered "$DEV_NAME" && state_claude=registered
    printf '%-20s %-10s %-11s %s\n' "$DEV_NAME" "$state_op" "$state_claude" "http://${DEV_HOST}:8080/mcp"
  done
}

cmd_store() {  # $1 slug, $2 generate|paste
  local token
  require_op
  need jq
  find_device "$1"
  if [[ "$2" == generate ]]; then
    need uuidgen
    token="$(uuidgen | tr '[:upper:]' '[:lower:]')"
  else
    [[ -t 0 ]] || fail "--paste needs an interactive terminal"
    read -r -s -p "Token for ${DEV_NAME} (input hidden): " token
    printf '\n'
  fi
  check_token "$token" "$ITEM"
  if item_exists "$ITEM"; then
    op item edit "$ITEM" --vault "$VAULT" "credential=${token}" >/dev/null
    printf 'Updated 1Password item %s (value not shown).\n' "$ITEM"
  else
    # New items come from the API Credential template so the value never
    # appears on a command line: it is written into a private temp file.
    op item template get "API Credential" >"${WORK}/template.json"
    TOKEN="$token" jq --arg title "$ITEM" \
      '.title = $title | .tags = ["agent-configs"] | (.fields[] | select(.id == "credential") | .value) = env.TOKEN' \
      "${WORK}/template.json" >"${WORK}/item.json"
    op item create --vault "$VAULT" --template "${WORK}/item.json" >/dev/null
    printf 'Created 1Password item %s (value not shown).\n' "$ITEM"
  fi
  unset token
}

cmd_install() {
  local entry token url
  require_op
  if [[ "$APPLY" == true ]]; then
    need claude
  fi
  for entry in "${DEVICES[@]}"; do
    parse_entry "$entry"
    selected "$DEV_SLUG" || continue
    ITEM="agent-configs-android-mcp-${DEV_SLUG}"
    url="http://${DEV_HOST}:8080/mcp"
    if ! item_exists "$ITEM"; then
      printf 'skip %s: 1Password item %s not found (run store first)\n' "$DEV_NAME" "$ITEM"
      continue
    fi
    if [[ "$APPLY" != true ]]; then
      printf 'plan %s: register %s with the token from %s\n' "$DEV_NAME" "$url" "$ITEM"
      continue
    fi
    token="$(read_token "$ITEM")"
    check_token "$token" "$ITEM"
    claude mcp remove --scope user "$DEV_NAME" >/dev/null 2>&1 || true
    claude mcp add --transport http --scope user "$DEV_NAME" "$url" --header "Authorization: Bearer ${token}" >/dev/null
    unset token
    printf 'registered %s -> %s (token from %s, value not shown)\n' "$DEV_NAME" "$url" "$ITEM"
  done
  if [[ "$APPLY" != true ]]; then
    printf 'Plan only. Re-run with --apply to update the Claude Code user config.\n'
  fi
}

cmd_verify() {
  local entry token url target code note route
  require_op
  need curl
  if [[ -n "$SERIAL" ]]; then
    need adb
    ((${#SELECTED[@]} == 1)) || fail "verify --serial needs exactly one --device"
  fi
  for entry in "${DEVICES[@]}"; do
    parse_entry "$entry"
    selected "$DEV_SLUG" || continue
    ITEM="agent-configs-android-mcp-${DEV_SLUG}"
    url="http://${DEV_HOST}:8080/mcp"
    if ! item_exists "$ITEM"; then
      printf '%s: skipped, 1Password item %s not found\n' "$DEV_NAME" "$ITEM"
      continue
    fi
    token="$(read_token "$ITEM")"
    check_token "$token" "$ITEM"
    printf 'Authorization: Bearer %s\n' "$token" >"${WORK}/auth.hdr"
    route="tailnet"
    target="$url"
    if [[ -n "$SERIAL" ]]; then
      # Temporary USB forward to the device's own server; the tailnet is not needed.
      adb -s "$SERIAL" forward tcp:18080 tcp:8080 >/dev/null
      route="usb ${SERIAL}"
      target="http://127.0.0.1:18080/mcp"
    fi
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "$target" \
      -H "@${WORK}/auth.hdr" \
      -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' \
      -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' || true)"
    if [[ -n "$SERIAL" ]]; then
      adb -s "$SERIAL" forward --remove tcp:18080 >/dev/null 2>&1 || true
    fi
    rm -f "${WORK}/auth.hdr"
    unset token
    case "$code" in
      200) note="ok" ;;
      401) note="token rejected; the device has a different token" ;;
      000) note="unreachable; check the route and that the server is running" ;;
      *) note="unexpected response" ;;
    esac
    printf '%s via %s: HTTP %s, %s\n' "$DEV_NAME" "$route" "$code" "$note"
  done
}

cmd_provision() {  # $1 slug
  local token out
  require_op
  find_device "$1"
  [[ -n "$SERIAL" ]] || fail "provision needs --serial <adb serial> (see: adb devices -l)"
  item_exists "$ITEM" || fail "1Password item ${ITEM} not found (run store first)"
  if [[ "$APPLY" != true ]]; then
    printf 'plan: set the bearer token on %s from %s (value not shown)\n' "$SERIAL" "$ITEM"
    if [[ "$START" == true ]]; then
      printf 'plan: start the MCP server on %s\n' "$SERIAL"
    fi
    printf 'Plan only. Re-run with --apply to change the device.\n'
    return 0
  fi
  need adb
  token="$(read_token "$ITEM")"
  check_token "$token" "$ITEM"
  out="$(adb -s "$SERIAL" shell "am broadcast -a ${ADB_ACTION} -n ${ADB_RECEIVER} --es bearer_token '${token}' --ez bearer_token_enabled true")"
  printf '%s\n' "$out" | grep -E 'Broadcast completed|Error|Exception' || true
  unset token
  # A running server keeps the token it started with, so restart it to apply the new one.
  running="$(adb -s "$SERIAL" shell dumpsys activity services "$APP_ID" | tr -d '\r' | grep -c 'ServiceRecord.*McpServerService' || true)"
  if [[ "${running:-0}" -gt 0 ]]; then
    adb -s "$SERIAL" shell "am start -n ${ADB_TRAMPOLINE} --es action stop" >/dev/null
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      still="$(adb -s "$SERIAL" shell dumpsys activity services "$APP_ID" | tr -d '\r' | grep -c 'ServiceRecord.*McpServerService' || true)"
      [[ "${still:-0}" -eq 0 ]] && break
      sleep 1
    done
    adb -s "$SERIAL" shell "am start -n ${ADB_TRAMPOLINE} --es action start" >/dev/null
    printf 'Restarted the MCP server on %s so the new token applies.\n' "$SERIAL"
  elif [[ "$START" == true ]]; then
    adb -s "$SERIAL" shell "am start -n ${ADB_TRAMPOLINE} --es action start" >/dev/null
    printf 'Started the MCP server on %s.\n' "$SERIAL"
  fi
  printf 'Set %s on %s from %s (value not shown). Clients holding the old token stop working.\n' "$DEV_NAME" "$SERIAL" "$ITEM"
}

COMMAND="${1:-}"
if (($# > 0)); then
  shift
fi
SLUG=""
MODE=""
APPLY=false
START=false
SERIAL=""
SELECTED=()
while (($#)); do
  case "$1" in
    --apply) APPLY=true; shift ;;
    --start) START=true; shift ;;
    --generate) MODE="generate"; shift ;;
    --paste) MODE="paste"; shift ;;
    --serial)
      (($# >= 2)) || fail "--serial needs a value"
      SERIAL="$2"
      shift 2
      ;;
    --device)
      (($# >= 2)) || fail "--device needs a value"
      SELECTED+=("$2")
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    -*) fail "unknown option: $1" ;;
    *)
      [[ -z "$SLUG" ]] || fail "unexpected argument: $1"
      SLUG="$1"
      shift
      ;;
  esac
done

case "$COMMAND" in
  status)
    [[ -z "$SLUG" ]] || fail "status takes no positional argument"
    cmd_status
    ;;
  store)
    [[ -n "$SLUG" ]] || fail "store needs a device slug"
    [[ -n "$MODE" ]] || fail "store needs --generate or --paste"
    cmd_store "$SLUG" "$MODE"
    ;;
  install)
    [[ -z "$SLUG" ]] || fail "install takes --device SLUG, not a positional argument"
    validate_selection
    cmd_install
    ;;
  verify)
    [[ -z "$SLUG" ]] || fail "verify takes --device SLUG, not a positional argument"
    validate_selection
    cmd_verify
    ;;
  provision)
    [[ -n "$SLUG" ]] || fail "provision needs a device slug"
    cmd_provision "$SLUG"
    ;;
  ""|-h|--help) usage ;;
  *) fail "unknown command: $COMMAND (see --help)" ;;
esac
