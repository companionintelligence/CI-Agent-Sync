#!/usr/bin/env zsh

set -euo pipefail

STORE_ROOT="${0:A:h:h}"
cd "$STORE_ROOT"

zsh -n bin/agent-store
zsh -n bin/agent-store-legacy
zsh -n bin/agentctl
zsh -n bin/agent-atlas
zsh -n bin/openclaw-runtime
zsh -n scripts/bootstrap-machine.zsh
zsh -n scripts/sync-repos.zsh
node --version | rg '^v(2[2-9]|[3-9][0-9])\.' >/dev/null
node --experimental-strip-types --no-warnings src/cli.ts check >/dev/null
node --experimental-strip-types --no-warnings src/test.ts >/dev/null
node --experimental-strip-types --no-warnings src/cli.ts conformance --json --timeout 5 >/dev/null
node --experimental-strip-types --no-warnings src/cli.ts harness-smoke --json --timeout 5 >/dev/null
node --experimental-strip-types --no-warnings src/cli.ts platform preflight --json >/dev/null
ruby -c scripts/redact-config.rb >/dev/null
ruby -c scripts/redact-text.rb >/dev/null
zsh -n scripts/doctor.rb
ruby -c scripts/render.rb >/dev/null
ruby -c scripts/sync.rb >/dev/null
ruby -c scripts/test_sync.rb >/dev/null
ruby -c scripts/validate.rb >/dev/null
ruby -c scripts/test.rb >/dev/null
zsh -n scripts/harness-smoke.rb
ruby -c scripts/harness_probe.rb >/dev/null
ruby -c scripts/test_harness_probe.rb >/dev/null
ruby -c scripts/backup.rb >/dev/null
ruby -c scripts/repair-openclaw.rb >/dev/null
ruby -c scripts/onepassword.rb >/dev/null
ruby -c scripts/process_helpers.rb >/dev/null
zsh -n scripts/conformance.rb
ruby -c scripts/readiness.rb >/dev/null
ruby -c scripts/export-report.rb >/dev/null
ruby -c scripts/action-ledger.rb >/dev/null
ruby -c scripts/test_action_ledger.rb >/dev/null
ruby -c scripts/profile.rb >/dev/null
ruby -c scripts/marketplace-audit.rb >/dev/null
ruby -c scripts/test_marketplace_audit.rb >/dev/null
ruby -c scripts/atlas-web.rb >/dev/null
ruby -c scripts/test_atlas_web.rb >/dev/null
ruby -c scripts/companion-cli.rb >/dev/null
ruby -c scripts/test_companion_cli.rb >/dev/null
npm run build >/dev/null
git diff --check

while IFS= read -r file; do
  ruby -ryaml -e 'YAML.safe_load_file(ARGV[0], aliases: true)' "$file"
done < <(rg --files integrations profiles repos | rg '\.ya?ml$')

ruby -ryaml -e 'YAML.safe_load_file(ARGV[0], aliases: false)' sync/manifest.yaml
ruby -ryaml -e 'YAML.safe_load_file(ARGV[0], aliases: false)' sync/targets.yaml.example
ruby -ryaml -e 'YAML.safe_load_file(ARGV[0], aliases: false)' .agent-configs/sync.yml.example
ruby scripts/validate.rb >/dev/null

ruby -ryaml -e '
  data = YAML.safe_load_file(ARGV[0], aliases: false)
  abort "fallback policy has no chains" unless data.fetch("chains").is_a?(Hash) && !data.fetch("chains").empty?
  abort "fallback policy has no client chains" unless data.fetch("client_chains").is_a?(Hash) && !data.fetch("client_chains").empty?
  data.fetch("chains").each do |name, chain|
    abort "fallback chain #{name} has no steps" unless chain.fetch("steps").is_a?(Array) && !chain.fetch("steps").empty?
  end
' integrations/providers/fallbacks.yaml

ruby scripts/test_sync.rb >/dev/null
ruby scripts/test_action_ledger.rb >/dev/null
ruby scripts/test_harness_probe.rb >/dev/null
ruby scripts/test_companion_cli.rb >/dev/null
ruby scripts/profile.rb list --json >/dev/null
ruby scripts/profile.rb show ceo --json >/dev/null

while IFS= read -r file; do
  ruby -rjson -e 'JSON.parse(File.read(ARGV[0]))' "$file"
done < <(rg --files integrations agents/vscode | rg '\.json$')

if rg -n --hidden -g '!work/**' -g '!.git/**' \
  '(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-|Bearer[[:space:]]+[A-Za-z0-9._-]{12,}|-----BEGIN (OPENSSH|RSA|EC) PRIVATE KEY-----)' .; then
  print -u2 'credential-like material found in the store'
  exit 1
fi

print 'agent-config store verification passed'
