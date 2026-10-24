# Harness synchronization audit

Audited and synchronized the machine-local harnesses on 2026-10-24. Native
state remains native; the Git store contains policy, recipes, and redacted
snapshots only.

## Applied

- Added `omlx` as a first-class local provider with the loopback endpoint
  `http://127.0.0.1:8000/v1`, the alternate `ollama` route, Keychain support,
  and integrated health checks.
- Aider Desk 0.88.0 now uses the OpenAI-compatible oMLX provider and
  `Qwen3.8-27B-oQ4e-fp16-mtp` in all three agent profiles. Its global MCP file
  registers CI-Common, CI-Engineering, and Metricool; local servers are enabled
  for coding profiles while Metricool remains available for explicit OAuth.
- Pi GUI 1.0.1 now has an `omlx-local` custom endpoint and the same Qwen 27B
  model as its default enabled model. Its native endpoint key is not captured
  in Git; the shared store has the local oMLX credential in macOS Keychain.
- OpenClaw's existing remote gateway and GitHub Copilot default were preserved
  because the configured gateway runs on another host. Its workspace now has
  the shared local-provider, MCP, marketing workflow, handoff, and device
  safety contract in `TOOLS.md`.
- Claude and Codex retain their native OAuth/config stores. Their local
  CI-Common and CI-Engineering MCP connections are healthy; Metricool is
  registered but still needs its OAuth authorization.
- VS Code and OpenCode remain on the reviewed MCP baseline; both local CI MCPs
  are connected and Metricool is awaiting OAuth.

## Verification

- oMLX `/v1/models` returned four models when called with the local key.
- The 27B model returned a valid Python palindrome implementation through
  `/v1/chat/completions` with `reasoning_effort=none`.
- Aider Desk loaded four OpenAI-compatible models for `omlx-local` and visibly
  switched the active project model to the 27B model.
- Pi GUI visibly showed one connected custom endpoint, one enabled model, and
  the 27B model selected as the default.
- Hermes doctor passed its local gateway/model profile checks; expected warnings
  remain for optional integrations and package advisories.
- `agent-store doctor`: 29 checks passed, 11 warnings, 0 errors.
- The portable store's YAML/JSON manifests and redaction snapshots parse; no
  credential value is present in tracked snapshots.

## Remaining gates

- Ollama is not running on this Mac; it remains an alternate route, not the
  current local backend.
- OpenClaw's configured remote gateway is not running/reachable from the
  current audit, so the new local route is documented but not made the default.
- Metricool OAuth is still required in Claude, Codex, OpenCode, VS Code, and
  Aider Desk before any publishing/scheduling operation.
- Companion Memory is not configured in the shared Keychain/endpoint overlay.
- Android remote-control MCP remains opt-in and unconfigured; no device was
  connected during this audit.
- Codex reports pre-existing missing rollout files and an available update;
  these are native app-state maintenance items, not store-sync failures.
- OpenClaw's historical native config contains credential-bearing entries;
  they were not copied or printed. Rotate/migrate those native credentials
  separately before sharing or transplanting that app directory.
