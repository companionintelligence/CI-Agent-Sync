#!/usr/bin/env zsh

set -euo pipefail

STORE_ROOT="${0:A:h:h}"
cd "$STORE_ROOT"

zsh -n bin/agent-store
zsh -n scripts/bootstrap-machine.zsh
ruby -c scripts/redact-config.rb >/dev/null
ruby -c scripts/redact-text.rb >/dev/null
git diff --check

while IFS= read -r file; do
  ruby -ryaml -e 'YAML.safe_load_file(ARGV[0], aliases: true)' "$file"
done < <(rg --files integrations profiles repos | rg '\.ya?ml$')

while IFS= read -r file; do
  ruby -rjson -e 'JSON.parse(File.read(ARGV[0]))' "$file"
done < <(rg --files integrations agents/vscode | rg '\.json$')

if rg -n --hidden -g '!work/**' -g '!.git/**' \
  '(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-|Bearer[[:space:]]+[A-Za-z0-9._-]{12,}|-----BEGIN (OPENSSH|RSA|EC) PRIVATE KEY-----)' .; then
  print -u2 'credential-like material found in the store'
  exit 1
fi

print 'agent-config store verification passed'
