#!/usr/bin/env zsh

# Compatibility path for the former Ruby conformance probe. The portable
# implementation lives in src/diagnostics.ts and is shared by every harness.
set -euo pipefail

store_root="${0:A:h:h}"
exec "$store_root/bin/agentctl" conformance "$@"
