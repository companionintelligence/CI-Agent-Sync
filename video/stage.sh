#!/usr/bin/env bash
#
# Agent Sync's stage, for local video capture. Sourced by video/make.sh (the
# kit's runner); this file only has to stand the wizard up and stop it again.
#
# The wizard is the whole product surface the film shows: a dependency-free
# Node 22 server on loopback. Two things keep the capture honest:
#
#   * HOME points at an EMPTY throwaway directory. The wizard's backup step
#     reads the agent configs found under the real home directory, and the
#     filmed machine must not leak the operator's own paths or settings.
#     The shots never click "Preview backup" (it prints a timestamped absolute
#     path), but a stage that could expose a real home is a stage to refuse.
#   * The store itself is NOT faked. Harnesses, profiles and counts are read
#     from this repo's own YAML, exactly as a user's clone would read them.

STAGE_PID=""
STAGE_HOME=""

stage_up() {
  stage_down

  STAGE_PORT="$(pick_port 8787)"
  STAGE_URL="http://127.0.0.1:$STAGE_PORT"
  export APP_URL="$STAGE_URL"
  [ "$STAGE_PORT" = 8787 ] || echo "note: :8787 was busy, using :$STAGE_PORT"

  ( cd "$REPO_ROOT" && npm ci --silent )

  STAGE_HOME="$(mktemp -d)"
  ( cd "$REPO_ROOT" && HOME="$STAGE_HOME" exec ./bin/agent-atlas --port "$STAGE_PORT" ) > "$STAGE_LOG" 2>&1 &
  STAGE_PID=$!

  for _ in $(seq 1 30); do
    code="$(curl -sS -o /dev/null -w '%{http_code}' "$STAGE_URL/healthz" 2>/dev/null || true)"
    [ -n "$code" ] && [ "$code" != 000 ] && break
    kill -0 "$STAGE_PID" 2>/dev/null || { echo "wizard exited during startup" >&2; return 1; }
    sleep 1
  done
  [ "${code:-000}" != 000 ] || { echo "wizard never answered on :$STAGE_PORT" >&2; return 1; }
  echo "stage up at $STAGE_URL"
}

stage_down() {
  if [ -n "$STAGE_PID" ] && kill -0 "$STAGE_PID" 2>/dev/null; then
    pkill -P "$STAGE_PID" 2>/dev/null || true
    kill "$STAGE_PID" 2>/dev/null || true
    wait "$STAGE_PID" 2>/dev/null || true
  fi
  # Anchor on the PORT, not the command: the process holding it is node, not
  # the bin/agent-atlas wrapper that was launched.
  local port="${STAGE_PORT:-8787}" pid
  pid="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null | head -1 || true)"
  [ -z "$pid" ] || kill "$pid" 2>/dev/null || true
  [ -z "$STAGE_HOME" ] || rm -rf "$STAGE_HOME"
  STAGE_PID=""; STAGE_HOME=""
}
