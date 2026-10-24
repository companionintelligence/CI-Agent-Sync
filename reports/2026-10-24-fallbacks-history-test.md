# Fallbacks, history, and cross-harness test — 2026-10-24

## Outcome

The portable store now has explicit local-first fallback chains in
`integrations/providers/fallbacks.yaml` and a compact context pack in
`context/agent-operating-context.md`. The context was distilled from local
Claude and Codex history plus the Companion Intelligence workspace rules. Raw
transcripts, session databases, OAuth state, credentials, and private device
data were not copied.

The native OpenClaw desktop configuration now has one reachable-provider
fallback: `github-copilot/claude-opus-4.6` after its existing
`github-copilot/gpt-5.2-codex` primary. Local oMLX is not inserted into that
native list because this OpenClaw profile points at a remote gateway; the Mac's
`127.0.0.1` is not the remote gateway's loopback.

## Portable fallback rules

- oMLX is first for local coding, reasoning, and marketing drafts.
- Ollama with `qwen3.8:27b-mlx` is the alternate local backend when it is
  running and the model is installed.
- OmniRoute, Anthropic, OpenAI, and OpenRouter require explicit enablement and
  authentication before they can be selected.
- Tool-calling fallbacks must retain tool capability.
- The selected provider/model must be visible in the handoff.
- No automatic fallback occurs after publishing, scheduling, device control,
  account changes, or destructive repository work begins.

## Live test evidence

| Surface | Result |
| --- | --- |
| Store verification | PASS — YAML/JSON/Ruby/Zsh checks and sync smoke tests |
| oMLX `/v1/models` | PASS — authenticated with the native secret store; 4 models |
| oMLX coding chat | PASS — authenticated Qwen 27B completion returned |
| Ollama `/api/tags` | WARN — not running on this machine |
| OmniRoute `/v1/models` | PASS — loopback protected; HTTP 401 without its gateway key |
| CI-Common MCP | PASS — JSON-RPC `initialize` + `tools/list`, 26 tools |
| CI-Engineering MCP | PASS — JSON-RPC `initialize` + `tools/list`, 9 tools |
| Hermes | PASS — doctor completed against the local profile |
| OpenClaw | PASS — doctor completed; fallback list contains one model |
| Claude skills | PASS — plugin validation passed |
| Codex MCP | PASS — server inventory listed; doctor still reports state/MCP notes |
| OpenCode | PASS — local service reachable and local MCPs connected |
| Aider Desk | PASS — embedded aider 0.86.2 and native JSON parsed |
| Pi GUI | PASS — native model/settings JSON parsed; app installed |
| Antigravity | PASS — app/config inventory present |
| VS Code | PASS — version and active MCP JSON parsed |

## Remaining gates

- OpenClaw's configured remote gateway is not running locally; the remote
  target must be reachable before its native fallback can be exercised.
- Ollama must be started and the alternate model installed before that branch
  is live.
- OmniRoute needs its access key and provider credentials entered locally.
- Metricool is registered but still needs OAuth in Claude/Codex/OpenCode.
- Companion Memory has no configured URL/key on this machine.
- Codex reports `TERM=dumb`, optional MCP environment issues, and three
  missing rollout files in its state database; no state was pruned.
- The Claude CLI `mcp list` health-check command exceeded its bounded probe;
  the underlying CI MCP servers passed direct protocol smoke tests.
