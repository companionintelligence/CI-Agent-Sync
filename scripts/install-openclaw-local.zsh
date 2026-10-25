#!/usr/bin/env zsh

set -euo pipefail

STORE_ROOT="${0:A:h:h}"
OPENCLAW_BIN="${OPENCLAW_BIN:-$STORE_ROOT/bin/openclaw-runtime}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  print -u2 "This installer currently targets the macOS OpenClaw LaunchAgent."
  exit 2
fi

[[ -n "$OPENCLAW_BIN" && -x "$OPENCLAW_BIN" ]] || {
  print -u2 "OpenClaw CLI not found. Set OPENCLAW_BIN to its executable."
  exit 2
}

if ! "$STORE_ROOT/bin/agent-store" credentials status | rg -q '^  ✓ omlx '; then
  print -u2 "Set the local oMLX credential first: ./bin/agent-store credentials set omlx"
  exit 2
fi

wrapper_dir="$HOME/.local/bin"
wrapper="$wrapper_dir/openclaw-gateway-with-omlx"
plist="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
mkdir -p "$wrapper_dir" "${plist:h}"

tmp_wrapper="$wrapper.tmp.$$"
cat > "$tmp_wrapper" <<EOF
#!/bin/zsh
set -euo pipefail
store_root="$STORE_ROOT"
bundled_runtime='/Applications/OpenClaw.app/Contents/Resources/runtime'
bundled_openclaw="\$bundled_runtime/lib/node_modules/openclaw/openclaw.mjs"
node_bin="\${OPENCLAW_NODE_BIN:-\$(whence -p node 2>/dev/null || true)}"
if [[ -n "\$node_bin" && -x "\$node_bin" && -f "\$bundled_openclaw" ]]; then
  exec "\$store_root/bin/agent-store" with omlx -- "\$node_bin" "\$bundled_openclaw" "\$@"
fi
exec "\$store_root/bin/agent-store" with omlx -- "$OPENCLAW_BIN" "\$@"
EOF
chmod 755 "$tmp_wrapper"
mv "$tmp_wrapper" "$wrapper"

# Let OpenClaw create or refresh its native LaunchAgent, preserving its
# generated gateway-auth environment. Then replace only the executable with
# the credential-injecting wrapper.
"$OPENCLAW_BIN" gateway install >/dev/null
/usr/libexec/PlistBuddy -c 'Delete :ProgramArguments' "$plist"
/usr/libexec/PlistBuddy -c 'Add :ProgramArguments array' "$plist"
/usr/libexec/PlistBuddy -c "Add :ProgramArguments:0 string $wrapper" "$plist"
/usr/libexec/PlistBuddy -c 'Add :ProgramArguments:1 string gateway' "$plist"
/usr/libexec/PlistBuddy -c 'Add :ProgramArguments:2 string --port' "$plist"
/usr/libexec/PlistBuddy -c 'Add :ProgramArguments:3 string 18789' "$plist"

uid="$(id -u)"
launchctl bootout "gui/$uid" "$plist" 2>/dev/null || true
launchctl bootstrap "gui/$uid" "$plist"
launchctl kickstart -k "gui/$uid/ai.openclaw.gateway"

print "Installed OpenClaw local gateway wrapper: $wrapper"
print "Gateway remains loopback-only; verify with: openclaw status --all"
