#!/usr/bin/env bash
# Install the Dafny release that integrations/verification/toolchains.yaml pins and put it
# on PATH for the later steps of a GitHub Actions job. scripts/verify.sh runs every spec
# registry check, and the path-containment proof needs Dafny. Run after `npm ci`, from the
# repository root. The zip is used only when its sha256 matches the pin.
set -euo pipefail

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) platform=arm64-macos-13 ;;
  Darwin-x86_64) platform=x64-macos-13 ;;
  Linux-x86_64) platform=x64-ubuntu-22.04 ;;
  *) echo "install-dafny: no pinned Dafny release for $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

pin="$(node -e '
  const { parse } = require("yaml");
  const text = require("node:fs").readFileSync("integrations/verification/toolchains.yaml", "utf8");
  const dafny = parse(text).toolchains.find((tool) => tool.id === "dafny");
  const release = dafny.install.find((entry) => entry.channel === "github-release");
  const file = `dafny-${dafny.version}-${process.argv[1]}.zip`;
  const sha256 = release.sha256[file];
  if (!/^[0-9a-f]{64}$/.test(sha256 ?? "")) throw new Error(`no sha256 pinned for ${file}`);
  console.log(dafny.version, file, sha256);
' "$platform")"
read -r version file sha256 <<<"$pin"

root="${RUNNER_TEMP:?}/dafny-$version"
mkdir -p "$root"
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --output "$root/$file" "https://github.com/dafny-lang/dafny/releases/download/v$version/$file"
echo "$sha256  $root/$file" | shasum -a 256 -c -
unzip -q -o "$root/$file" -d "$root"
"$root/dafny/dafny" --version
echo "$root/dafny" >>"${GITHUB_PATH:?}"
