# VS Code and Companion Intelligence audit

Date: 2026-10-24 (America/Los_Angeles)

This is a repository and local-tooling audit. It separates portable recipes from
machine state and does not claim that every desktop or appliance flow has been
run on a live remote node.

## VS Code

- VS Code 1.143.1 is installed on Apple Silicon.
- 33 extensions are installed. The portable extension allowlist is grouped in
  `integrations/vscode/extensions.txt`; the versioned machine snapshot is in
  `agents/vscode/extensions.txt`.
- The agent plugin registry records two reviewed GitHub Awesome Copilot
  plugins: `skill-image-gen` and `ai-team-orchestration`.
- The global MCP file originally had seven entries, including two stale Unity
  definitions: one used the placeholder command `other`, and one used a
  Windows-only executable path. Both were backed up and removed from the live
  Mac config.
- The global settings contained a one-off terminal auto-approval for an old
  CI-Hub checkout and branch. It was backed up and removed; portable policy
  keeps approval decisions machine- and task-specific.
- Chrome DevTools MCP was pinned from 0.21.0 to 1.12.0 and Playwright MCP was
  pinned from `latest` to 0.0.83. The active JSON remains valid after repair.
- GitHub and Hugging Face remote MCP entries remain host-authenticated; no
  token was copied into the store. Companion Memory is represented as an
  optional environment-backed template, not enabled by copying a key.

## Companion Intelligence repository map

The canonical set is recorded in `repos/companionintelligence.yaml`:

- **Companion-Hub** (`dev`, public): appliance runtime, Tauri desktop app,
  marketplace lifecycle, and MCP bridge. It requires Node 22+, pnpm 11, and
  Docker. Its agent workflow requires the router, system docs, app run,
  cross-agent review, and `bin/agent-validate-shift`.
- **Companion-Memory** (`main`, private): memory appliance and MCP server.
  Its documented client endpoint is `/api/mcp`; scope-limited keys need both
  `mcp` and `intents`, with the lowest required capability.
- **CI-Portal** (`dev`, private): cloud identity, entitlements, distribution,
  and ingress. Its `dev -> staging -> main` path is fast-forward promotion only.
- **CI-Common**, **CI-Engineering**, **CI-Docs**, **CI-Hermes**,
  **CI-OpenClaw**, **CI-Marketplace**, **CI-Spellbook**, and
  **CI-Local-CICD** are captured with their roles, default branches, skill
  sources, and setup expectations.
- Legacy `CompanionHub` and archived private Hub history are explicitly
  excluded so a new machine does not accidentally clone the wrong repository.

The live machine has clean checkouts for CI-Docs, CI-Hermes, CI-OpenClaw, and
CI-Local-CICD; CI-Common and CI-Spellbook are dirty and are preserved. Several
canonical repos are not checked out locally, so the manifest reports them as
missing rather than silently treating the machine as complete.

## Skills, plugins, and MCPs

The store now has separate registries for skills, plugins, and MCP servers.
They record source, target client, validation command, required credentials,
and trust boundaries without copying native state. The most important shared
connections are:

- Companion Hub's `.claude/skills` and `.cursor/skills` workflow set;
- CI-Engineering's local loopback dashboard MCP server;
- CI-Hermes and CI-OpenClaw runtime skills for container persistence and
  networking;
- the CI-OpenClaw Companion Memory plugin;
- the native Claude skill directory and VS Code agent plugin registry;
- the optional Companion Memory streamable-HTTP server for clients that need
  shared memory.

## Portability decisions

- Provider credentials continue to use Keychain/native OAuth. The store only
  carries provider names, env-var mappings, and injection helpers.
- Native databases, session history, rollout stores, absolute paths, VPN
  hostnames, and one-off approvals are audit artifacts, not bootstrap inputs.
- MCP package versions are pinned in the reviewed examples. A server is not
  considered operational until the calling process can reach it and complete a
  safe handshake.
- Skill/plugin installs are explicit and review-first. The store does not
  blindly execute third-party install instructions on a new machine.

## Remaining gates

- Companion-Hub, Companion-Memory, CI-Portal, CI-Engineering, and
  CI-Marketplace need local checkouts on a new machine before repository-level
  tests can run.
- The Companion Memory URL and API key still need to be entered locally and
  tested from each client process that should use it.
- The local OmniRoute endpoint is healthy but access-protected; routing remains
  unconfigured until its access key and provider credentials are intentionally
  entered and `/v1/models` succeeds.
