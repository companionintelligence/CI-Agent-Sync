#!/usr/bin/env zsh

# Compatibility path for older scripts. The doctor implementation is owned by
# the Node control plane; keeping this filename lets existing launchers migrate
# without maintaining a second Ruby implementation.
set -euo pipefail

store_root="${0:A:h:h}"
exec "$store_root/bin/agentctl" doctor "$@"
