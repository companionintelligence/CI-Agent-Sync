# Shared harness routing

This is the portable handoff contract for the local agent clients. It keeps
native app state local while giving every harness the same provider, MCP, and
workflow vocabulary.

## Provider order on this Mac

1. `omlx` at `http://127.0.0.1:8000/v1` with
   `Qwen3.8-27B-oQ4e-fp16-mtp` for private local coding.
2. `ollama` at `http://127.0.0.1:11434` as the alternate local backend.
3. `omniroute` on loopback when a gateway route is intentionally enabled.
4. Claude, OpenAI, or OpenRouter through native OAuth/API-key handling or an
   explicitly selected gateway route.
5. Companion Memory through the `/api/mcp` appliance endpoint only after the
   reachable URL and scoped key have been tested from the calling process.

Credentials are resolved from the machine's native secret store. Do not copy
API keys, OAuth sessions, or app databases into this repository.

## Client matrix

| Client | Local model | Shared MCP | Portable handoff |
| --- | --- | --- | --- |
| Hermes | oMLX/Ollama | CI-Common and CI-Engineering opt-in | `workflows/marketing-video.md` |
| OpenClaw | native default or oMLX when launched with the helper | skills/workspace context; no native MCP command | `~/.openclaw/workspace/TOOLS.md` |
| Aider Desk | `omlx-local/Qwen3.8-27B-oQ4e-fp16-mtp` | global CI-Common, CI-Engineering, Metricool recipe | `~/Library/Application Support/aider-desk/mcp-servers.json` |
| Pi GUI | `omlx-local/Qwen3.8-27B-oQ4e-fp16-mtp` | configure only reviewed servers | `~/.pi/agent/models.json` |
| Claude | native provider or gateway | CI-Common, CI-Engineering, Metricool OAuth | `agents/claude/mcp.redacted.yaml` |
| Codex | native provider or gateway | CI-Common, CI-Engineering, Metricool OAuth | `agents/codex/config.redacted.toml` |
| VS Code | gateway/remote or local | reviewed MCP baseline | `integrations/vscode/mcp.json.example` |

## Handoff recipe

Every client should receive the same short context in this order:

1. `/Users/liam/devel/ci/AGENTS.md` and the target repository's own rules.
2. The provider policy in `integrations/providers/routing.yaml`.
3. The relevant MCP entry in `integrations/mcp/registry.yaml`.
4. The marketing workflow when the task touches Brand Studio, CI-Common,
   CI-Engineering, or Metricool.
5. A compact handoff containing changed files, tests, links/artifacts, and
   remaining gates.

Fallback behavior is defined in
`integrations/providers/fallbacks.yaml`: prefer authenticated oMLX, then
Ollama, then an explicitly enabled gateway or remote provider. The selected
provider and model must be visible, tool capability must be preserved, and a
fallback must stop before publishing, scheduling, device control, account
changes, or destructive repository operations.

The internal MCP set is also portable:

- `ci-brand-studio` — local Asset Engine dashboard MCP over stdio.
- `ci-engineering` — local engineering and product-video MCP over stdio.
- `companion-hub` — Hub control-plane MCP at `/api/mcp`, with a scoped Hub key.
- `companion-memory` — Memory MCP at `/api/mcp`, with a key carrying `mcp` and
  `intents` scopes.

All four are opt-in in the registry. Native clients should only enable the
HTTP services after their endpoint and key are configured locally.

Keep mutations approval-gated: publishing, scheduling, device control,
account changes, and destructive repository operations always require explicit
confirmation in the client that performs them.
