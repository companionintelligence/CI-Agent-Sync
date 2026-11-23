#!/usr/bin/env zsh

set -euo pipefail

STORE_ROOT="${0:A:h:h}"
cd "$STORE_ROOT"

# Ruby reads this store's JSON and YAML as UTF-8. A shell without a UTF-8 locale (LANG
# unset, as in many terminals) makes Ruby read them as US-ASCII and fail on the first
# non-ASCII byte. Add the encoding unless the caller already chose one.
if [[ "${RUBYOPT:-}" != *-E* ]]; then
  export RUBYOPT="-Eutf-8${RUBYOPT:+ $RUBYOPT}"
fi

# Captured output of each check lives in one directory, removed however the gate ends,
# including Ctrl-C.
gate_tmp="$(mktemp -d)"
trap 'rm -rf "$gate_tmp"' EXIT
trap 'exit 130' INT TERM

# Run one check. A passing check prints nothing except its own stderr warnings. A failing
# check names the call site and the command, prints everything it printed, and stops the
# gate. The earlier `>/dev/null` redirects threw that output away, so a failure looked
# like a bare exit 1.
quiet() {
  local out err site
  out="$(mktemp "$gate_tmp/out.XXXXXX")"
  err="$(mktemp "$gate_tmp/err.XXXXXX")"
  if "$@" >"$out" 2>"$err"; then
    cat "$err" >&2
    return 0
  fi
  site="${funcfiletrace[1]:-unknown}"
  print -u2 -- "verify.sh: check failed at ${site}: $*"
  cat "$out" "$err" >&2
  exit 1
}

node_major="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_major < 22 )); then
  print -u2 -- "verify.sh: Node 22 or newer is required; found $(node --version)"
  exit 1
fi

zsh -n bin/agent-store
zsh -n bin/agent-store-legacy
zsh -n bin/agentctl
zsh -n bin/agent-atlas
zsh -n bin/openclaw-runtime
zsh -n scripts/bootstrap-machine.zsh
zsh -n scripts/sync-repos.zsh
quiet node --experimental-strip-types --no-warnings src/cli.ts check
quiet node --experimental-strip-types --no-warnings src/test.ts
quiet node --experimental-strip-types --no-warnings src/cli.ts conformance --json --timeout 5
quiet node --experimental-strip-types --no-warnings src/cli.ts harness-smoke --json --timeout 5
quiet node --experimental-strip-types --no-warnings src/cli.ts platform preflight --json
quiet ruby -c scripts/redact-config.rb
quiet ruby -c scripts/redact-text.rb
zsh -n scripts/doctor.rb
quiet ruby -c scripts/render.rb
quiet ruby -c scripts/sync.rb
quiet ruby -c scripts/test_sync.rb
quiet ruby -c scripts/validate.rb
zsh -n scripts/harness-smoke.rb
quiet ruby -c scripts/harness_probe.rb
quiet ruby -c scripts/test_harness_probe.rb
quiet ruby -c scripts/backup.rb
quiet ruby -c scripts/repair-openclaw.rb
quiet ruby -c scripts/onepassword.rb
quiet ruby -c scripts/process_helpers.rb
zsh -n scripts/conformance.rb
quiet ruby -c scripts/readiness.rb
quiet ruby -c scripts/export-report.rb
quiet ruby -c scripts/action-ledger.rb
quiet ruby -c scripts/test_action_ledger.rb
quiet ruby -c scripts/profile.rb
quiet ruby -c scripts/marketplace-audit.rb
quiet ruby -c scripts/test_marketplace_audit.rb
quiet ruby -c scripts/atlas-web.rb
quiet ruby -c scripts/test_atlas_web.rb
quiet ruby -c scripts/companion-cli.rb
quiet ruby -c scripts/test_companion_cli.rb
quiet npm run build

# web/app.js is committed, so a bundle built from an older web/app.ts would ship unnoticed.
# The check compares the fresh build with HEAD, which is what a push publishes.
bundle_status=0
git diff --quiet HEAD -- web/app.js || bundle_status=$?
if (( bundle_status == 1 )); then
  print -u2 -- 'verify.sh: web/app.js differs from HEAD after a fresh build; commit the rebuilt bundle (this check compares against HEAD)'
  git --no-pager diff --stat HEAD -- web/app.js >&2
  exit 1
elif (( bundle_status > 1 )); then
  print -u2 -- "verify.sh: could not compare web/app.js with HEAD (git exit ${bundle_status})"
  exit 1
fi

git diff --check

# The listings are assigned without a guard, so a failing rg (for example a missing
# directory, exit 2) stops the gate here. Only the filter may come up empty.
listed_yaml="$(rg --files integrations profiles repos)"
yaml_files="$(print -r -- "$listed_yaml" | rg '\.ya?ml$' || true)"
[[ -n "$yaml_files" ]] || { print -u2 -- 'verify.sh: found no YAML files to check'; exit 1; }
while IFS= read -r file; do
  ruby -ryaml -e 'YAML.safe_load_file(ARGV[0], aliases: true)' "$file" || { print -u2 -- "verify.sh: invalid YAML: $file"; exit 1; }
done <<< "$yaml_files"

ruby -ryaml -e 'YAML.safe_load_file(ARGV[0], aliases: false)' sync/manifest.yaml
ruby -ryaml -e 'YAML.safe_load_file(ARGV[0], aliases: false)' sync/targets.yaml.example
ruby -ryaml -e 'YAML.safe_load_file(ARGV[0], aliases: false)' .agent-configs/sync.yml.example
quiet ruby scripts/validate.rb

ruby -ryaml -e '
  data = YAML.safe_load_file(ARGV[0], aliases: false)
  abort "fallback policy has no chains" unless data.fetch("chains").is_a?(Hash) && !data.fetch("chains").empty?
  abort "fallback policy has no client chains" unless data.fetch("client_chains").is_a?(Hash) && !data.fetch("client_chains").empty?
  data.fetch("chains").each do |name, chain|
    abort "fallback chain #{name} has no steps" unless chain.fetch("steps").is_a?(Array) && !chain.fetch("steps").empty?
  end
' integrations/providers/fallbacks.yaml

# scripts/test.rb runs the fixtures for sync, process helpers, the Hub and Memory control
# rooms, the marketplace audit, the web bundle and the companion CLI. The gate used to
# syntax-check most of those files without running them, so run the aggregate itself.
quiet ruby scripts/test.rb
quiet ruby scripts/test_action_ledger.rb
quiet ruby scripts/test_harness_probe.rb
quiet ruby scripts/profile.rb list --json
quiet ruby scripts/profile.rb show ceo --json

listed_json="$(rg --files integrations agents/vscode)"
json_files="$(print -r -- "$listed_json" | rg '\.json$' || true)"
[[ -n "$json_files" ]] || { print -u2 -- 'verify.sh: found no JSON files to check'; exit 1; }
while IFS= read -r file; do
  ruby -rjson -e 'JSON.parse(File.read(ARGV[0]))' "$file" || { print -u2 -- "verify.sh: invalid JSON: $file"; exit 1; }
done <<< "$json_files"

# The PowerShell scripts in scripts/ are parsed here, never run: their behavioural tests
# need Windows with Unity and Unreal installed. A missing pwsh fails on CI, where it should
# be installed, and is skipped with a visible warning on a developer machine.
powershell_skipped=0
if command -v pwsh >/dev/null 2>&1; then
  quiet pwsh -NoProfile -File .github/scripts/check-powershell-syntax.ps1
elif [[ -n "${CI:-}" ]]; then
  print -u2 -- 'verify.sh: pwsh is not installed on this CI runner, so the PowerShell syntax check cannot run'
  exit 1
else
  powershell_skipped=1
  print -u2 -- 'verify.sh: warning: pwsh is not installed; the PowerShell syntax check was skipped on this machine'
fi

# Only file names are printed. Printing matching lines would echo a secret into the log.
# ripgrep exits 2 on any unreadable file, even when it found a match, so read the status.
credential_pattern='(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-|Bearer[[:space:]]+[A-Za-z0-9._-]{12,}|-----BEGIN (OPENSSH|RSA|EC) PRIVATE KEY-----)'
credential_status=0
rg -l --hidden -g '!work/**' -g '!.git/**' "$credential_pattern" . || credential_status=$?
if (( credential_status == 0 )); then
  print -u2 -- 'credential-like material found in the store (file names above; contents not printed)'
  exit 1
elif (( credential_status > 1 )); then
  print -u2 -- "credential scan did not finish (ripgrep exit ${credential_status}); fix unreadable files and rerun"
  exit 1
fi

if (( powershell_skipped )); then
  print 'agent-config store verification passed (PowerShell syntax check skipped: pwsh not installed)'
else
  print 'agent-config store verification passed'
fi
