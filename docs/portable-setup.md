# Portable setup

This store is the portable control plane for the agent tools on a machine. It
keeps provider names, reviewed MCP and plugin recipes, repository roles, and
redacted audits in Git while keeping credential values in a shared 1Password
vault and native app state where each client expects it.

## New machine

```sh
git clone https://github.com/mrhegemon/agent-configs.git
cd agent-configs
cp profiles/machines/macos-laptop.yaml.example profiles/machines/local.yaml
./scripts/bootstrap-machine.zsh
./bin/agent-store inventory
./bin/agentctl credentials op setup
./bin/agentctl credentials op import
./bin/agent-store credentials status
./bin/agent-store audit all
./bin/agent-store vscode audit
./bin/agent-store repos inventory
```

Set only the providers you intend to use. The prompt is hidden and the value is
written to the configured 1Password vault; it is never written to this
repository:

```sh
./bin/agent-store credentials set anthropic
./bin/agent-store credentials set openai
./bin/agent-store credentials set openrouter
./bin/agent-store credentials set ollama
./bin/agent-store credentials set omlx
./bin/agent-store credentials set companion-hub
./bin/agent-store credentials set companion-memory
./bin/agent-store credentials set omniroute
./bin/agent-store credentials set android-mcp
```

Use `./bin/agent-store with <provider> -- <command>` for one process when a
client needs an environment variable. 1Password is resolved first and the
native migration source is used only while explicitly allowed. Native OAuth stores remain native to
Claude, Codex, VS Code, and the desktop apps. The `companion-hub` provider is
for Hub control-plane MCP. The separate `companion-memory` provider is for
Memory MCP; set `COMPANION_HUB_BASE_URL` and `COMPANION_MEMORY_BASE_URL`
independently when the services have different origins. Memory keys need both
`mcp` and `intents` scopes for a useful tool list.

The OmniRoute credential is intentionally only a 1Password item. This store
does not create a gateway key automatically; configure one locally, then use
`OMNIROUTE_BASE_URL=http://127.0.0.1:20128` for the loopback gateway.

The `omlx` provider is the preferred local route on this Mac. Its default
OpenAI-compatible endpoint is `http://127.0.0.1:8000/v1`; use `ollama` as the
alternate local route when oMLX is not installed or the model is unavailable.
The endpoint key stays in 1Password and is injected only for a
process launched with `agent-store with omlx -- ...`.

On macOS, after installing oMLX and entering the credential, install the
OpenClaw service wrapper with:

```sh
./scripts/install-openclaw-local.zsh
```

This refreshes only the native LaunchAgent entrypoint and keeps OpenClaw on a
loopback gateway. It does not copy credentials into the store or OpenClaw
configuration. The wrapper resolves it from 1Password at launch.

OpenClaw local mode uses the same endpoint through its built-in `openai`
provider. Keep `apiKey` set to the environment-variable name
`OPENAI_API_KEY`, never to a credential. Its gateway should bind to loopback,
keep Tailscale exposure off, and use the 1Password-backed wrapper installed on
the machine so the LaunchAgent receives the credential without persisting it
in `openclaw.json` or `models.json`. The recommended local-model guardrail is
`agents.defaults.sandbox.mode = "all"` with `tools.deny = ["group:web",
"browser"]`; Docker Desktop must be running for OpenClaw sandboxing.

The `android-mcp` credential is stored as `ANDROID_MCP_TOKEN` and injected only
when requested. Never copy a bearer token from a planning document or commit a
device URL; use `adb forward` and the local MCP URL by default.

## What is portable

- provider names and environment-variable mappings;
- reviewed repository manifest and branch conventions;
- MCP server recipes with pinned package versions and no secrets;
- skill and plugin sources, validation commands, and trust notes;
- the provider-neutral marketing-video workflow spanning Brand Studio,
  CI-Common, CI-Engineering, and Metricool;
- VS Code extension list and safe baseline settings;
- redacted snapshots and repair/audit helpers.

## What is deliberately not portable

- API key values, OAuth refresh tokens, cookies, private keys, and native auth files;
- SQLite databases, session history, rollout stores, or app caches;
- absolute paths, host-specific VPN names, or machine-specific auto-approval;
- unreviewed third-party skills, plugins, or MCP servers.

## Companion Intelligence order

The platform layers are intentionally kept separate:

1. **Companion Hub** — appliance runtime, desktop app, MCP bridge, and app
   lifecycle. Use `pnpm`, Node 22+, and Docker.
2. **Companion Memory** — memory appliance and MCP server. A client connection
   uses `/api/mcp`, an API key with `mcp` + `intents`, and the lowest required
   capability.
3. **Companion Portal** — cloud identity, entitlements, and distribution. Its
   `dev -> staging -> main` promotion flow is fast-forward only.
4. **CI-Common, CI-Engineering, CI-Docs, CI-Hermes, CI-OpenClaw,
   CI-Marketplace, CI-Spellbook, and CI-Local-CICD** — shared assets,
   operations, docs, packaging, marketplace, and reviewed agent context.

The repository manifest is the source for checkout paths and default branches;
it does not automatically clone, install, push, or promote anything.

For an intentional machine preparation pass, use
`./scripts/bootstrap-machine.zsh --apply`. To also clone missing canonical
repositories, add `--clone-reviewed-repos`; existing checkouts are preserved.

`./bin/agent-store repos sync` is plan-only. Add `--apply` to fetch and
fast-forward clean checkouts. Dirty or detached repositories are reported and
skipped, matching the parent workspace safety policy.

## Render and health

Generate safe, ignored artifacts without overwriting native client state:

```sh
./bin/agent-store render
open local/rendered/workspace/companion-intelligence.local.code-workspace
```

The render includes VS Code settings/MCP templates, an Aider Desk MCP file with
machine paths resolved from the local profile, extension IDs, client launch
notes, and both full and local-only Companion Intelligence workspaces.

Run the integrated health graph in human or machine-readable form:

```sh
./bin/agent-store doctor
./bin/agent-store doctor --json
```

Warnings are expected when optional agents, provider credentials, Companion
Memory, or the OmniRoute access key are not configured. The doctor never prints
secret values and does not create credentials.

## Distribute reviewed config to repositories

The store also supports a local, plan-first distribution layer for shared
agent policy. It borrows the useful parts of the AI Harness pattern—manifested
items, target-local selection, include/exclude overrides, and explicit cleanup
records—without copying native app state or credentials.

```sh
cp sync/targets.yaml.example sync/targets.yaml
# edit machine-local target paths
./bin/agent-store sync
./bin/agent-store sync --apply
```

The default is a dry-run plan. Dirty or detached Git checkouts are skipped, and
only files in [sync/manifest.yaml](../sync/manifest.yaml) can be copied. A
target can add `.agent-configs/sync.yml` to disable sync or select a narrower
set of groups. Deletions require both an explicit manifest entry and
`--prune --apply`.

## MCP safety

Start with the registry in `integrations/mcp/registry.yaml`. Keep network
servers disabled until their URL and auth path are tested from the process that
will call them. Keep stdio package versions pinned. For Companion Memory, a
successful MCP handshake proves auth and reachability; a loaded plugin alone
does not.

For the local CI Engineering server, the MCP process is only a thin client of
the loopback dashboard; confirmation and write guards remain on the dashboard.

The marketing workflow is documented in
[workflows/marketing-video.md](../workflows/marketing-video.md). Use its
environment variables and client recipes rather than copying native MCP state;
that keeps the same campaign loop usable from any supported harness or model
backend.

## VS Code

`integrations/vscode/mcp.json.example` is a reviewed baseline. Copy only the
entries needed on a machine. The active global file must not contain hard-coded
Windows paths, placeholder commands, `@latest` package references, or one-off
terminal auto-approval rules tied to a deleted checkout.

Install the extension IDs in `integrations/vscode/extensions.txt` through the
VS Code CLI or UI, then run `./bin/agent-store snapshot` to capture a redacted
machine audit.
