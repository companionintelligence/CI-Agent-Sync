# Portable control-plane hardening

## Delivered

- Added `bin/agentctl` as the stable entry point for inventory, health,
  validation, smoke tests, backups, rendering, sync, credentials, and repair.
- Added canonical harness metadata for Hermes, OpenClaw, Claude, Codex,
  OpenCode, Aider Desk, Antigravity, Pi, VS Code, and Ollama.
- Added `core`, `development`, `marketing`, and high-risk `mobile` MCP
  capability bundles. Remote, publishing, scheduling, and device-control
  surfaces remain opt-in and approval-gated.
- Added cross-reference validation, redacted backup bundles, harness smoke
  checks, a local coding probe, sync rollback backups, and recovery docs.
- Added `repair openclaw` for schema drift and stale optional plugin/model
  references without copying or printing native credentials.

## Live evidence on this Mac

- Hermes `0.20.4` used the active `ollama-local` profile and the installed
  `Qwen3.8-27B-oQ4e-fp16-mtp` oMLX model. A one-shot coding probe completed.
- OpenClaw desktop runtime `2026.10.6` gateway health returned `ok`; the
  desktop-matched gateway loaded without plugin errors.
- OpenClaw completed a real gateway agent turn with the local Qwen model and
  returned the expected harmless coding result. Provider/model selection was
  `openai/Qwen3.8-27B-oQ4e-fp16-mtp`, with no fallback used.
- oMLX returned HTTP 200 with the native Keychain credential. The direct local
  coding probe returned HTTP 200 and matched the expected result.
- Claude skills validation passed; OpenCode reported `ci-common` and
  `ci-engineering` connected; Aider Desk, Antigravity, Pi, and VS Code were
  present and discoverable.
- Static validation, sync tests, full store verification, render, backup, and
  cross-reference checks passed.

## Remaining intentional gates

- Ollama is installed but not running; oMLX is the active local backend.
- OmniRoute is reachable on loopback but its separate gateway credential is
  not configured.
- Metricool remains pending native OAuth authorization.
- OpenClaw reports optional device-pair, command-owner, legacy browser-relay,
  stale session metadata, and one session SQLite maintenance warning. None is
  required for the local coding path; do not enable device control or public
  gateway binding without an explicit target and owner decision.
- Codex reports missing historical rollout files and optional MCP environment
  variables; its current config, auth, desktop app, WebSocket, and provider
  reachability checks remain healthy.
- Literal provider/skill keys found in the old OpenClaw config were removed
  from that config. Rotate any previously used Google/OpenAI keys as a
  precaution; the store keeps only native secret-store references.
