#!/usr/bin/env zsh
# Fail when a file under the given folder (default: the current one) holds a
# credential-shaped string. verify.sh runs this over the checkout; rg skips ignored files.
# Only file names are printed: printing matching lines would echo a secret into the log.
# Exit 1 means found, exit 2 means the scan did not finish. src/credential-scan.test.ts
# runs generated fake values of every format against it.
set -euo pipefail

cd "${1:-.}"

patterns=(
  # OpenAI (plain, project, service account, admin), Anthropic and OpenRouter keys
  'sk-[A-Za-z0-9]{16,}'
  '\bsk-(proj|svcacct|admin|ant-api[0-9]+|ant-admin[0-9]+|or-v1)-[A-Za-z0-9_-]{20,}'
  # GitHub classic, OAuth, user, app, refresh and fine-grained tokens
  '\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})'
  # GitLab, Hugging Face, npm, Google and Stripe
  '\bglpat-[A-Za-z0-9_-]{20}'
  '\bhf_[A-Za-z0-9]{30,}'
  '\bnpm_[A-Za-z0-9]{36}'
  '\bAIza[0-9A-Za-z_-]{35}'
  '\b(sk|rk)_live_[A-Za-z0-9]{16,}'
  # Slack
  'xox[abeprs]-'
  '\bxapp-[0-9]-[A-Z0-9]+-[0-9]+-[a-f0-9]{16,}'
  # AWS access key ids, permanent and temporary
  '\b(AKIA|ASIA)[0-9A-Z]{16}\b'
  # Authorization values
  'Bearer[[:space:]]+[A-Za-z0-9._-]{12,}'
  '(?i:authorization)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?(?i:basic)[[:space:]]+[A-Za-z0-9+/]{12,}'
  # PEM and PGP private keys
  '-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----'
)

expressions=()
for pattern in $patterns; do expressions+=(-e "$pattern"); done

# ripgrep exits 2 on any unreadable file, even when it found a match, so read the status.
found=0
rg -l --hidden -g '!work/**' -g '!.git/**' "${expressions[@]}" . || found=$?
if (( found == 0 )); then
  print -u2 -- 'credential-like material found in the files above (contents not printed)'
  exit 1
elif (( found > 1 )); then
  print -u2 -- "credential scan did not finish (ripgrep exit ${found}); fix unreadable files and rerun"
  exit 2
fi
