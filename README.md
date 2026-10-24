# Agent Config Store

This is the local, versionable home for Liam's agent configuration templates,
provider mappings, helper commands, redacted audits, and setup notes.

The store is maintained in [mrhegemon/agent-configs](https://github.com/mrhegemon/agent-configs).
It is a portable control plane, not a mirror of native app state: secrets stay
in Keychain or the client’s native auth store, while reviewed recipes and
redacted audits live here.

## Secret policy

Secrets are never copied into this repository. Provider credentials use the
machine's supported secret store under the `agent-configs` namespace; on
Windows, use each client's native auth until a shared backend is selected.
Tool-specific OAuth files remain in their native application directories.
Audits and config snapshots redact credential-bearing fields.

Start here:

```sh
./bin/agent-store inventory
./bin/agent-store credentials status
./bin/agent-store audit hermes
./bin/agent-store audit openclaw
./bin/agent-store audit all
./bin/agent-store snapshot
./bin/agent-store vscode audit
./bin/agent-store repos inventory
./bin/agent-store repos sync
./bin/agent-store render
./bin/agent-store sync
./bin/agent-store doctor
./bin/agent-store doctor --json
./scripts/bootstrap-machine.zsh
```

Add a provider credential locally, without putting it in chat or a tracked
file:

```sh
./bin/agent-store credentials set anthropic
./bin/agent-store credentials set openai
./bin/agent-store credentials set openrouter
./bin/agent-store credentials set ollama
./bin/agent-store credentials set omlx
./bin/agent-store credentials set companion-hub
./bin/agent-store credentials set omniroute
./bin/agent-store credentials set android-mcp
```

Run a client with a provider credential injected only into that process:

```sh
./bin/agent-store with anthropic -- claude
./bin/agent-store with openai -- codex
```

See [docs/audit-checklist.md](docs/audit-checklist.md) for the full review
scope and [reports/2026-10-24-hermes-openclaw.md](reports/2026-10-24-hermes-openclaw.md)
for the first completed phase. The portable setup and Companion Intelligence
repository map are in [docs/portable-setup.md](docs/portable-setup.md) and
[repos/companionintelligence.yaml](repos/companionintelligence.yaml).

The repository distribution contract is in [sync/](sync/README.md). It uses a
versioned manifest, target-local group selection, explicit deletion records,
and plan-first application so reviewed policies can be transplanted without
copying native auth or credentials.

For the marketing stack, start with
[workflows/marketing-video.md](workflows/marketing-video.md). It connects
CI-Brand-Studio planning, CI-Common production, CI-Engineering evidence, and
Metricool analytics across Claude, Codex, OpenCode, and VS Code, with opt-in
recipes for lean local Hermes and OpenClaw.

The mobile references are catalogued in
[integrations/references.yaml](integrations/references.yaml). The Android
remote-control MCP is deliberately opt-in and high-risk; the private Companion
Scan document is stored as a link only, without importing its credentials or
device-specific endpoints.
