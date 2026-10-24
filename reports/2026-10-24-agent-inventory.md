# Agent inventory and phase-two audit

Date: 2026-10-24 (America/Los_Angeles)

This is an inventory and risk review, not a claim that every desktop flow has
been physically exercised. Desktop-only state is marked separately.

## Claude Code

- Native CLI 2.1.296 and Claude.app 3.6556.2 are installed.
- `claude doctor` passed with no installation issues; native auto-updates are
  enabled and the latest update attempt succeeded.
- Claude has 22 local skill directories and one enabled plugin,
  `codex@openai-codex`.
- `~/.claude/settings.json` contains a custom permission allowlist, hooks, and
  four Android MCP token environment entries. The redacted snapshot is stored
  in `agents/claude/settings.redacted.json`; the token values were not copied.
- Follow-up: map those Android MCP tokens to their consumers before deciding
  whether to migrate them into Keychain-backed process injection. Removing them
  from native settings blindly could break Android tooling.

## Codex

- Codex CLI 0.150.1 is installed from the standalone distribution; the
  desktop app is installed and running.
- `codex doctor` found healthy databases, valid config parsing, ChatGPT auth,
  working websocket connectivity, and a healthy desktop app-server startup.
- An update is available. The report also found three missing archived rollout
  files, duplicate rollout IDs, one stale row, and optional MCP issues: missing
  browser-use environment values and an unresolved Unity MCP executable path.
- The effective config enables `danger-full-access` sandboxing with network
  access and has ten MCP servers. This is a deliberate high-impact setting to
  review, not an automatic repair target.
- Follow-up: repair or disable the stale Unity MCP entry, decide the browser
  MCP environment policy, and handle rollout database cleanup only after a
  recoverable backup.

## Antigravity

- Antigravity 2.25.0 and Antigravity IDE 2.5.5 are installed.
- State, conversation databases, annotations, and local helper binaries exist.
- The IDE MCP config exists but is empty, so no configured MCP server was
  inferred. This is desktop-only coverage until the app is opened and its
  settings/skills UI is inspected.

## OpenCode

- CLI 2.1.2 and OpenCode.app 2.1.4 are installed.
- Native auth reports stored Anthropic, OpenCode Console, and OpenRouter
  credentials; values were not exported or copied.
- No MCP servers are configured in the CLI. The CLI config is explicitly set
  to a local Ollama-compatible provider and a Qwen 3.6 35B model.
- The desktop config loads a local OmniRoute plugin at `localhost:20128`.
  This is preserved as a machine-local integration; its gateway/provider
  credentials still need a separate local health test before being called
  operational.
- Follow-up: validate the OmniRoute access-key/provider path and decide whether
  OpenCode should use the shared store's provider launcher or its native auth.

## Aider Desk

- Aider Desk 0.88.0 is installed.
- Its native config and embedded Python environment are present. The configured
  provider is Ollama at the local HTTP API; no MCP servers or preferred models
  are configured.
- Follow-up: inspect the desktop provider UI and run one local-model smoke test.

## Pi

- Pi GUI 1.0.1 is installed; no `pi` CLI is currently on PATH.
- `~/.pi/agent/models-store.json` and `auth.json` exist with empty top-level
  objects, so no configured model or auth was inferred.
- Follow-up: open the GUI, identify whether its bundled runtime is intended to
  replace the missing CLI, and configure providers through the shared store.

## Shared risks

- The same machine has multiple native credential stores. The shared helper
  therefore reports presence and injects credentials per process; it does not
  copy secrets between clients.
- Skill inventories are heterogeneous: Hermes has an explicit installed skill
  registry, OpenClaw reports eligible and missing requirements, Claude has local
  skill directories, and the desktop apps expose skills through their UIs.
- The next safe implementation step is targeted repair of Codex MCP drift and
  Claude's plaintext MCP-token settings, followed by desktop smoke checks.
