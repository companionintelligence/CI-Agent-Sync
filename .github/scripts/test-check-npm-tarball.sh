#!/usr/bin/env bash
#
# Tests the npm tarball guard: check-npm-tarball.mjs, the "files" list in package.json and
# the prepublishOnly interlock. Run it from anywhere inside the repository after
# `npm ci`:  .github/scripts/test-check-npm-tarball.sh
#
# It works in a throwaway clone of the COMMITTED state (commit first) and never touches
# the working tree. The point is to keep a leak from coming back unnoticed, so it plants
# sentinel files the way a developer's machine accumulates them, packs, and requires
# that none of them gets past both the "files" list and the check.

set -euo pipefail

root="$(git rev-parse --show-toplevel)"
check="${root}/.github/scripts/check-npm-tarball.mjs"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
failures=0

pass() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; failures=$((failures + 1)); }

# ── 1. the rules, over lists ─────────────────────────────────────────────────────────
echo "rules (no tarball)"

required="package.json LICENSE README.md dist/cli.js dist/atlas-bin.js bin/agentctl bin/agent-store-legacy web/index.html web/app.js sync/manifest.yaml"

# lists_check <entry or ""> <extra tracked path or ""> [required entry to leave out]
lists_check() {
  local entry="$1" tracked_extra="$2" omit="${3:-}" item
  : >"${work}/entries"
  : >"${work}/tracked"
  for item in ${required}; do
    [ "${item}" = "${omit}" ] || printf 'package/%s\n' "${item}" >>"${work}/entries"
    printf '%s\n' "${item}" >>"${work}/tracked"
  done
  printf '%s\n' src/cli.ts src/atlas-bin.ts >>"${work}/tracked"
  if [ -n "${entry}" ]; then printf 'package/%s\n' "${entry}" >>"${work}/entries"; fi
  if [ -n "${tracked_extra}" ]; then printf '%s\n' "${tracked_extra}" >>"${work}/tracked"; fi
  set +e
  out="$(node "${check}" --all --entries "${work}/entries" --tracked "${work}/tracked" 2>&1)"
  rc=$?
  set -e
}

# A tracked file is only caught by the name rules, so these prove the second layer.
for path in \
  agents/id_rsa agents/id_ed25519.pub agents/server.pem providers/tls.key providers/client.p12 \
  providers/store.pfx providers/keystore.jks providers/.netrc providers/.git-credentials \
  providers/credentials providers/credentials.json sync/service-account.json sync/service_account.json \
  docs/token.txt docs/api-key.txt docs/password.txt integrations/secrets.yaml integrations/secret.txt \
  providers/env providers/prod.env providers/local.env providers/.env providers/.env.local providers/.envrc \
  agents/auth.json agents/.credentials.json agents/oauth-token.json agents/client-secret.json \
  agents/claude/claude.redacted.json agents/vscode/extensions.txt sync/targets.yaml profiles/machines/local.yaml \
  agents/state.db agents/agent.log agents/notes.bak agents/known_hosts agents/.DS_Store \
  agents/local/x.json docs/work/x.txt docs/state/raw/x.txt integrations/reports/raw/x.txt sync/node_modules/pkg/index.js \
  src/cli.ts video/storyboard.json reports/raw.md; do
  lists_check "${path}" "${path}"
  if [ "${rc}" = 1 ] && grep -qF -- "${path}" <<<"${out}"; then pass "flags even when tracked: ${path}"; else bad "did not flag tracked ${path} (rc=${rc})"; fi
done

# These are tracked, shipped and must keep passing, including the names that merely
# contain "token", "secret" or "password".
for path in \
  providers/.env.example providers/onepassword.env.example providers/onepassword.yaml docs/onepassword.md \
  scripts/onepassword.rb web/assets/ci-common/tokens.css agents/hermes/onepassword-secrets.example.yaml \
  agents/hermes/config.yaml.example integrations/mcp/registry.yaml scripts/validate.rb dist/cli.js; do
  lists_check "${path}" "${path}"
  if [ "${rc}" = 0 ]; then pass "accepts ${path}"; else bad "rejected legitimate ${path}: ${out}"; fi
done

# Untracked with an innocent name: only the first rule can catch these.
for path in agents/claude/config.json agents/claude/settings.json agents/codex/config.toml agents/hermes/current.yaml docs/notes.md web/extra.js; do
  lists_check "${path}" ""
  if [ "${rc}" = 1 ] && grep -qF -- "${path}" <<<"${out}"; then pass "flags untracked ${path}"; else bad "did not flag untracked ${path} (rc=${rc})"; fi
done

# dist/ is build output, so it is held to "compiled form of a tracked src/ file".
lists_check "dist/evil.js" ""
if [ "${rc}" = 1 ]; then pass "flags dist/evil.js (no tracked src/evil.ts)"; else bad "accepted dist/evil.js"; fi
lists_check "dist/cli.js.map" ""
if [ "${rc}" = 1 ]; then pass "flags dist/cli.js.map"; else bad "accepted dist/cli.js.map"; fi
lists_check "dist/test.js" "src/test.ts"
if [ "${rc}" = 1 ]; then pass "flags dist/test.js even though src/test.ts is tracked"; else bad "accepted dist/test.js"; fi

# A package that cannot run must not go out.
lists_check "" "" dist/atlas-bin.js
if [ "${rc}" = 1 ] && grep -qF dist/atlas-bin.js <<<"${out}"; then pass "flags a missing required entry"; else bad "accepted a tarball without dist/atlas-bin.js"; fi

printf 'package/../escape\nelsewhere/file\n' >"${work}/entries"
: >"${work}/tracked"
set +e
out="$(node "${check}" --all --entries "${work}/entries" --tracked "${work}/tracked" 2>&1)"
rc=$?
set -e
if [ "${rc}" = 1 ] && grep -qF elsewhere/file <<<"${out}" && grep -qF 'package/../escape' <<<"${out}"; then pass "flags paths outside package/"; else bad "accepted a path outside package/"; fi

set +e
node "${check}" /nonexistent.tgz >/dev/null 2>&1
rc=$?
set -e
if [ "${rc}" = 2 ]; then pass "exits 2, not 0, when it cannot read the tarball"; else bad "unreadable tarball gave exit ${rc}, expected 2"; fi

# ── 2. a real tarball from a tree littered with sentinels ────────────────────────────
echo "tarball from a littered clone"

if [ ! -d "${root}/node_modules" ]; then
  echo "node_modules is missing: run npm ci first (the clone is built with it)" >&2
  exit 2
fi
tree="${work}/tree"
git clone -q --no-hardlinks "${root}" "${tree}"
ln -s "${root}/node_modules" "${tree}/node_modules"
(cd "${tree}" && npm run build:cli --silent)

pack() { # pack <out dir> -> prints the tarball path
  mkdir -p "$1"
  printf '%s/%s\n' "$1" "$(cd "${tree}" && npm pack --ignore-scripts --silent --pack-destination "$1")"
}

clean="$(pack "${work}/clean")"
if out="$(cd "${tree}" && node "${check}" "${clean}" 2>&1)"; then pass "a clean clone passes: ${out#npm tarball check passed: }"; else bad "a clean clone failed: ${out}"; fi

# Plant every sentinel name in every directory that ships, plus new and nested ones.
names="server.pem tls.key client.p12 store.pfx keystore.jks app.keystore AuthKey_ABC.p8 putty.ppk secring.gpg vault.kdbx
id_rsa id_rsa.pub id_dsa id_ecdsa id_ecdsa.pub id_ed25519 id_ed25519.pub known_hosts authorized_keys
.netrc _netrc .git-credentials .pypirc .htpasswd .pgpass .npmrc .envrc .env .env.local .env.production
env local.env prod.env secrets.env onepassword.env
credentials credentials.json credentials.yaml service-account.json service_account.json
token.txt api-key.txt apikey.json password.txt secrets.yaml secret.txt auth.json .credentials.json oauth-token.json client-secret.json
config.json settings.json claude.json current.json current.yaml config.toml opencode.jsonc state.db cache.sqlite agent.log notes.bak .DS_Store"
shipped_roots="bin scripts web agents context docs integrations profiles providers repos sync workflows .agent-configs"
{
  # shellcheck disable=SC2086 # the roots are a list of plain words
  (cd "${tree}" && git ls-files -- ${shipped_roots} | while IFS= read -r file; do dirname "${file}"; done)
  echo agents/zz-new-agent
  echo dist
} | sort -u >"${work}/dirs"
: >"${work}/planted"
while IFS= read -r dir; do
  mkdir -p "${tree}/${dir}"
  for name in ${names}; do
    printf 'SENTINEL\n' >"${tree}/${dir}/${name}"
    printf '%s/%s\n' "${dir}" "${name}" >>"${work}/planted"
  done
done <"${work}/dirs"
for path in local/x.json work/x.txt state/raw/x.txt reports/raw/x.txt node_modules/pkg/index.js \
  agents/local/x.json agents/work/x.txt docs/state/raw/x.txt integrations/reports/raw/x.txt sync/node_modules/pkg/index.js; do
  mkdir -p "${tree}/$(dirname "${path}")"
  printf 'SENTINEL\n' >"${tree}/${path}"
  printf '%s\n' "${path}" >>"${work}/planted"
done
sort -o "${work}/planted" "${work}/planted"
planted_count="$(wc -l <"${work}/planted" | tr -d ' ')"

# verify_pass <label> <expectation>: pack the littered tree, require the check to fail
# whenever a sentinel is in the tarball and to name every one of them.
verify_pass() {
  local label="$1" tarball leaked unreported path
  tarball="$(pack "${work}/dirty-${label}")"
  tar -tzf "${tarball}" | sed 's#^package/##' | sort >"${work}/entries-${label}"
  comm -12 "${work}/planted" "${work}/entries-${label}" >"${work}/leaked-${label}"
  leaked="$(wc -l <"${work}/leaked-${label}" | tr -d ' ')"
  set +e
  (cd "${tree}" && node "${check}" --all "${tarball}") >"${work}/check-${label}" 2>&1
  rc=$?
  set -e
  if [ "${leaked}" -gt 0 ] && [ "${rc}" != 1 ]; then
    bad "${label}: ${leaked} sentinels are in the tarball and the check exited ${rc}"
    return
  fi
  unreported=0
  while IFS= read -r path; do
    grep -qF -- "  ${path}" "${work}/check-${label}" || { unreported=$((unreported + 1)); printf '          not reported: %s\n' "${path}"; }
  done <"${work}/leaked-${label}"
  if [ "${unreported}" = 0 ]; then
    pass "${label}: ${planted_count} sentinels planted, ${leaked} reached the tarball, the check names all ${leaked}"
  else
    bad "${label}: ${unreported} of ${leaked} sentinels that reached the tarball were not reported"
  fi
  PASS_LEAKED="${leaked}"
}

# (a) with the "files" list as committed;
verify_pass files-as-committed

# (b) with every "!" exclusion stripped from it, so the check is the only layer left.
(cd "${tree}" && node -e "
  const fs = require('node:fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.files = pkg.files.filter((entry) => !entry.startsWith('!'));
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));")
verify_pass files-without-exclusions
if [ "${PASS_LEAKED}" -gt 0 ]; then pass "the exclusions are what keeps ${PASS_LEAKED} of them out when absent, so (a) is not vacuous"; else bad "stripping the exclusions leaked nothing, so this test proves nothing"; fi

# ── 3. the publish interlock ─────────────────────────────────────────────────────────
echo "publish interlock"
git -C "${tree}" checkout -q -- package.json

if (cd "${tree}" && env -u GITHUB_ACTIONS npm run prepublishOnly --silent >/dev/null 2>"${work}/refusal"); then
  bad "prepublishOnly allowed a publish outside GitHub Actions"
else
  if grep -q 'npm-publish.yml' "${work}/refusal"; then pass "prepublishOnly refuses outside GitHub Actions, and says where releases come from"; else bad "prepublishOnly failed without the explanation"; fi
fi
if (cd "${tree}" && GITHUB_ACTIONS=true npm run prepublishOnly --silent >/dev/null 2>&1); then pass "prepublishOnly lets a GitHub Actions run through"; else bad "prepublishOnly blocked a GitHub Actions run"; fi

# Real npm, pointed at a dead registry and with --dry-run, so nothing can be uploaded.
# `npm publish` from the tree must trigger the hook; `npm publish <tarball>` (what the
# workflow does) must not.
dead="http://127.0.0.1:9/"
if (cd "${tree}" && env -u GITHUB_ACTIONS npm publish --dry-run --registry "${dead}" >/dev/null 2>"${work}/publish-tree"); then
  bad "npm publish --dry-run from the tree was not refused"
else
  if grep -q 'Refusing to publish' "${work}/publish-tree"; then pass "npm publish from a working tree is refused"; else bad "npm publish from the tree failed for another reason: $(tail -3 "${work}/publish-tree")"; fi
fi
if (cd "${tree}" && env -u GITHUB_ACTIONS npm publish "${clean}" --dry-run --registry "${dead}" >/dev/null 2>"${work}/publish-tarball"); then
  pass "npm publish <tarball> is not blocked by the interlock (it skips lifecycle scripts)"
else
  bad "npm publish <tarball> --dry-run failed: $(tail -3 "${work}/publish-tarball")"
fi

echo
if [ "${failures}" = 0 ]; then
  echo "all checks passed"
else
  echo "${failures} check(s) failed" >&2
  exit 1
fi
