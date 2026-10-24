#!/usr/bin/env zsh

set -euo pipefail

STORE_ROOT="${0:A:h:h}"
MANIFEST="$STORE_ROOT/repos/companionintelligence.yaml"
CI_ROOT="${CI_ROOT:-$HOME/devel/ci}"
apply=false

case "${1:-}" in
  "") ;;
  --apply) apply=true ;;
  --help)
    print "Usage: sync-repos.zsh [--apply]"
    print "Default mode reports actions only; --apply fetches and fast-forwards clean checkouts."
    exit 0
    ;;
  *) print -u2 "Unknown option: $1"; exit 2 ;;
esac

print "Repository sync mode: $([[ "$apply" == true ]] && print apply || print plan)"
print "CI root: $CI_ROOT"

ruby -ryaml -e '
  data = YAML.load_file(ARGV[0])
  root = ARGV[1]
  data.fetch("repositories").each do |repo|
    path = repo.fetch("local_path").gsub("${CI_ROOT}", root).gsub("${HOME}", Dir.home)
    puts [repo.fetch("name"), repo.fetch("default_branch"), path].join("\t")
  end
' "$MANIFEST" "$CI_ROOT" | while IFS=$'\t' read -r name expected_branch repo_path; do
  if [[ ! -d "$repo_path/.git" ]]; then
    print "  $name — missing — skipped"
    continue
  fi

  branch="$(git -C "$repo_path" branch --show-current)"
  if [[ -z "$branch" ]]; then
    print "  $name — detached — skipped"
    continue
  fi

  if [[ -n "$(git -C "$repo_path" status --porcelain)" ]]; then
    print "  $name — dirty on $branch — skipped"
    continue
  fi

  upstream="$(git -C "$repo_path" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [[ -z "$upstream" ]]; then
    print "  $name — $branch has no upstream — skipped"
    continue
  fi

  if [[ "$apply" == true ]]; then
    git -C "$repo_path" fetch --all --prune
    git -C "$repo_path" pull --ff-only
    print "  $name — updated $branch"
  else
    print "  $name — would fetch and pull --ff-only on $branch"
  fi
done
