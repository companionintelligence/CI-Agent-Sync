#!/usr/bin/env bash
#
# usage: assert-doctor-json.sh <doctor.json>
#
# `agentctl backup` captures `agentctl doctor --json` by running the CLI a second time.
# If that child cannot run (an installed package whose backup still points at src/, which
# an install does not have), backup still exits 0 and writes a stub instead:
#
#   {"schema_version":1,"summary":{"error":1},"error":"doctor did not return JSON"}
#
# The stub carries a schema_version too, so that key proves nothing. Only real doctor
# output has a list of checks, so that is what this asserts on.

set -euo pipefail

file="${1:?usage: assert-doctor-json.sh <doctor.json>}"
if ! jq -e '(.checks | length) > 0' "${file}" >/dev/null 2>&1; then
  held="$(head -c 300 "${file}" 2>/dev/null | tr -s '[:space:]' ' ' || true)"
  echo "::error::${file} is not doctor output (it has no checks), so the packaged CLI could not re-invoke itself. It holds: ${held:-(unreadable)}"
  exit 1
fi
