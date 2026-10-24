# Portable setup

This store is the portable control plane for the agent tools on a machine. It
keeps provider names, reviewed MCP and plugin recipes, repository roles, and
redacted audits in Git while leaving credentials and native app state where the
operating system expects them.

## New machine

```sh
git clone https://github.com/mrhegemon/agent-configs.git
cd agent-configs
cp profiles/machines/macos-laptop.yaml.example profiles/machines/local.yaml
./scripts/bootstrap-machine.zsh
./bin/agent-store inventory
./bin/agent-store credentials status
./bin/agent-store audit all
./bin/agent-store vscode audit
./bin/agent-store repos inventory
```

Set only the providers you intend to use. The prompt is hidden and the value is
written to the macOS Keychain; it is never written to this repository:

```sh
./bin/agent-store credentials set anthropic
./bin/agent-store credentials set openai
./bin/agent-store credentials set openrouter
./bin/agent-store credentials set ollama
./bin/agent-store credentials set companion-hub
```

Use `./bin/agent-store with <provider> -- <command>` for one process when a
client needs an environment variable. Native OAuth stores remain native to
Claude, Codex, VS Code, and the desktop apps. The `companion-hub` provider
also injects the `CI_SERVER_TOKEN` alias used by the OpenClaw Companion Memory
plugin; set `COMPANION_HUB_BASE_URL` and `CI_SERVER_URL` separately for the
chosen reachable appliance address.

## What is portable

- provider names and environment-variable mappings;
- reviewed repository manifest and branch conventions;
- MCP server recipes with pinned package versions and no secrets;
- skill and plugin sources, validation commands, and trust notes;
- VS Code extension list and safe baseline settings;
- redacted snapshots and repair/audit helpers.

## What is deliberately not portable

- API keys, OAuth refresh tokens, cookies, private keys, and native auth files;
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

## MCP safety

Start with the registry in `integrations/mcp/registry.yaml`. Keep network
servers disabled until their URL and auth path are tested from the process that
will call them. Keep stdio package versions pinned. For Companion Memory, a
successful MCP handshake proves auth and reachability; a loaded plugin alone
does not.

For the local CI Engineering server, the MCP process is only a thin client of
the loopback dashboard; confirmation and write guards remain on the dashboard.

## VS Code

`integrations/vscode/mcp.json.example` is a reviewed baseline. Copy only the
entries needed on a machine. The active global file must not contain hard-coded
Windows paths, placeholder commands, `@latest` package references, or one-off
terminal auto-approval rules tied to a deleted checkout.

Install the extension IDs in `integrations/vscode/extensions.txt` through the
VS Code CLI or UI, then run `./bin/agent-store snapshot` to capture a redacted
machine audit.
