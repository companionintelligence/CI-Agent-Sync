# Liam's Magic Agent Config Store

This is the local, versionable home for Liam's agent configuration templates,
provider mappings, helper commands, redacted audits, and setup notes.

The store is maintained in [mrhegemon/agent-configs](https://github.com/mrhegemon/agent-configs).
It is a portable control plane, not a mirror of native app state: credential
values stay in the shared 1Password vault, while reviewed recipes and redacted
audits live here. Client-native OAuth state remains local to each app.

## Secret policy

Secrets are never copied into this repository. Provider credentials use the
shared 1Password `Agent Configs` vault through `op://` references; Keychain and
Secret Service are migration fallbacks only.
Tool-specific OAuth files remain in their native application directories.
Audits and config snapshots redact credential-bearing fields.

Start here:

```sh
./bin/agentctl inventory
./bin/agentctl doctor --json
./bin/agentctl test
./bin/agentctl conformance --json
./bin/agentctl hub smoke --json
./bin/agentctl hub smoke --json --strict --from-1password
./bin/agentctl memory smoke --json
./bin/agentctl fleet smoke --json
./bin/agentctl deploy doctor --json
./bin/agentctl backup
./bin/agentctl repair openclaw
./bin/agentctl credentials op status
./bin/agentctl render
./bin/agentctl sync
./bin/agentctl install
```

The underlying commands remain available for compatibility:

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
./bin/agent-store fallbacks
./bin/agent-store doctor
./bin/agent-store doctor --json
./scripts/bootstrap-machine.zsh
```

The control-plane lifecycle, separation of policy/secrets/native state, and
portable recovery model are documented in
[docs/control-plane.md](docs/control-plane.md). Harness readiness is tested in
tiers described by [docs/harness-parity.md](docs/harness-parity.md).

Provider order and safety rules are in
[integrations/providers/fallbacks.yaml](integrations/providers/fallbacks.yaml).
The compact context that travels with each target is in
[context/agent-operating-context.md](context/agent-operating-context.md).
Fallbacks are local-first and health-gated; remote providers require explicit
enablement, and no fallback is allowed after a mutation begins.

Reviewed MCPs are grouped in
[integrations/capability-bundles.yaml](integrations/capability-bundles.yaml):
`core`, `development`, `marketing`, `operator-readonly`, and high-risk
`mobile`/`operator-admin`/`deployment-admin`. Bundles describe
what can be enabled; they do not copy credentials or silently enable remote or
device-control tools.

The Companion Hub control-room and CEO change contract are in
[integrations/hub-operator.yaml](integrations/hub-operator.yaml) and
[workflows/ceo-operations.md](workflows/ceo-operations.md). The control-room
probe is read-only and keeps the Hub's MCP, `qa:read`, and `inference` keys
separate so a model can diagnose the appliance without receiving an admin key.

The laptop integration surfaces are also explicit: `memory smoke` checks the
local Companion Memory Caddy origin, `fleet smoke` checks Tailscale-named Hub
liveness across the verified beta/core targets, and `deploy doctor` checks
Cloudflare identity plus local Hub/Memory/Tailscale state without deploying.
See [workflows/deployment.md](workflows/deployment.md) for the confirmation
gates for Wrangler, Hub catalog submission, and fleet updates.

Set up the portable 1Password backend first:

```sh
./bin/agentctl credentials op setup
./bin/agentctl credentials op import
./bin/agentctl credentials op status
```

The import keeps native migration copies until verification. See
[docs/onepassword.md](docs/onepassword.md) for the desktop integration,
headless service-account, rotation, and fallback policy.

For a provider credential that is not yet migrated, add it locally without
putting it in chat or a tracked file:

```sh
./bin/agent-store credentials set anthropic
./bin/agent-store credentials set openai
./bin/agent-store credentials set openrouter
./bin/agent-store credentials set ollama
./bin/agent-store credentials set omlx
./bin/agent-store credentials set companion-hub
./bin/agent-store credentials set companion-hub-qa
./bin/agent-store credentials set companion-hub-inference
./bin/agent-store credentials set companion-hub-fleet-qa
./bin/agent-store credentials set companion-memory
./bin/agent-store credentials set omniroute
./bin/agent-store credentials set android-mcp
./bin/agent-store credentials set cloudflare
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

ChatGPT is tracked as a first-class desktop harness, but its hosted account
and native app database remain local. The portable provider chain is injected
into Codex CLI, Hermes, OpenClaw, Claude, OpenCode, Aider Desk, Pi, Antigravity,
and VS Code; ChatGPT can review or prepare work and then hand an approved
command to a local harness.

The latest fallback and cross-harness evidence is recorded in
[reports/2026-10-24-fallbacks-history-test.md](reports/2026-10-24-fallbacks-history-test.md).
The portable control-plane, OpenClaw repair, and live local-model evidence are
recorded in
[reports/2026-10-24-control-plane-hardening.md](reports/2026-10-24-control-plane-hardening.md).
The current laptop, local Memory/Hub, Tailscale fleet, Cloudflare, and harness
readiness review is recorded in
[reports/2026-10-24-laptop-ceo-operator-review.md](reports/2026-10-24-laptop-ceo-operator-review.md).
The internal MCP source review is in
[reports/2026-10-24-internal-mcp-registry.md](reports/2026-10-24-internal-mcp-registry.md).

For CI-Hub fleet work, use the plan-first policy in
[integrations/fleet/pool-policy.yaml](integrations/fleet/pool-policy.yaml) and
follow [docs/fleet-operations.md](docs/fleet-operations.md). The latest
repair evidence is in
[reports/2026-10-24-fleet-pool-repair.md](reports/2026-10-24-fleet-pool-repair.md).

For whole-platform and marketplace QA, select the `platform-qa` bundle and
follow [workflows/platform-qa.md](workflows/platform-qa.md). It exposes the
guarded CI-Engineering `fleet_qa_*` MCP tools to every supported local
harness, requires an explicit node list or `all: true`, and requires
confirmation before marketplace app-suite control. The per-node
`FLEET_HUB_API_KEYS_JSON` value is stored only as
`agent-configs-companion-hub-fleet-qa` in 1Password.

The mobile references are catalogued in
[integrations/references.yaml](integrations/references.yaml). The Android
remote-control MCP is deliberately opt-in and high-risk; the private Companion
Scan document is stored as a link only, without importing its credentials or
device-specific endpoints.
