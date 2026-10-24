#!/usr/bin/env zsh

set -euo pipefail

STORE_ROOT="${0:A:h:h}"
apply=false
clone=false

usage() {
  cat <<'EOF'
bootstrap-machine.zsh — prepare a machine from the reviewed store

Default: print a plan only.
  --apply                  create the ignored local overlay and install VS Code extensions
  --clone-reviewed-repos   clone missing repositories from the canonical manifest
  --help                   show this help

Credentials, OAuth state, skills, plugins, and MCP servers remain explicit
follow-up actions because their trust and auth requirements differ by client.
EOF
}

for arg in "$@"; do
  case "$arg" in
    --apply) apply=true ;;
    --clone-reviewed-repos) clone=true ;;
    --help) usage; exit 0 ;;
    *) print -u2 "Unknown option: $arg"; usage; exit 2 ;;
  esac
done

machine_overlay="$STORE_ROOT/profiles/machines/local.yaml"
extension_file="$STORE_ROOT/integrations/vscode/extensions.txt"
manifest="$STORE_ROOT/repos/companionintelligence.yaml"
ci_root="${CI_ROOT:-$HOME/devel/ci}"

print "Agent store: $STORE_ROOT"
print "CI root: $ci_root"
print "Mode: $([[ "$apply" == true ]] && print apply || print plan)"
print ""

for requirement in git ruby; do
  if command -v "$requirement" >/dev/null 2>&1; then
    print "  ✓ $requirement"
  else
    print "  ! missing prerequisite: $requirement"
  fi
done

if command -v op >/dev/null 2>&1; then
  print "  ✓ 1Password CLI (op)"
else
  print "  ! 1Password CLI (op) not found"
  case "$(uname -s)" in
    Darwin) print "    install with: brew install 1password-cli" ;;
    Linux) print "    install from: https://developer.1password.com/docs/cli/get-started/" ;;
    *) print "    install the 1Password CLI for this platform" ;;
  esac
fi

if command -v code >/dev/null 2>&1; then
  print "  ✓ code"
else
  print "  · VS Code CLI not found; extension installation will be skipped"
fi

if [[ ! -f "$machine_overlay" ]]; then
  print ""
  print "  local overlay: missing"
  print "  planned: copy profiles/machines/macos-laptop.yaml.example to profiles/machines/local.yaml"
else
  print "  ✓ local overlay: present"
fi

if [[ "$apply" == true ]]; then
  if [[ ! -f "$machine_overlay" ]]; then
    cp "$STORE_ROOT/profiles/machines/macos-laptop.yaml.example" "$machine_overlay"
    print "Created ignored machine overlay: $machine_overlay"
  fi

  if command -v code >/dev/null 2>&1; then
    while IFS= read -r extension; do
      [[ -z "$extension" || "$extension" == \#* ]] && continue
      code --install-extension "$extension" >/dev/null
      print "Installed VS Code extension: $extension"
    done < "$extension_file"
  fi
fi

if [[ "$clone" == true ]]; then
  command -v ruby >/dev/null 2>&1 || { print -u2 "Ruby is required to read the repository manifest"; exit 2; }
  mkdir -p "$ci_root"
  ruby -ryaml -e '
    data = YAML.load_file(ARGV[0])
    root = ARGV[1]
    data.fetch("repositories").each do |repo|
      path = repo.fetch("local_path").gsub("${CI_ROOT}", root).gsub("${HOME}", Dir.home)
      puts [repo.fetch("name"), repo.fetch("remote"), repo.fetch("default_branch"), path].join("\t")
    end
  ' "$manifest" "$ci_root" | while IFS=$'\t' read -r name remote branch destination; do
    if [[ -e "$destination/.git" ]]; then
      print "Kept existing checkout: $name ($destination)"
    else
      mkdir -p "${destination:h}"
      git clone --branch "$branch" "$remote" "$destination"
    fi
  done
fi

print ""
print "Next steps:"
print "  ./bin/agentctl credentials op status"
print "  ./bin/agent-store credentials status"
print "  ./bin/agentctl doctor --json"
print "  ./bin/agentctl test"
print "  ./bin/agentctl backup"
print "  ./bin/agent-store audit all"
print "  ./bin/agent-store vscode audit"
print "  ./bin/agent-store repos inventory"
print "  Review integrations/skills.yaml, integrations/plugins.yaml, and integrations/mcp/registry.yaml before installing optional entries."
