# Skills, extensions, and smoke-test audit

Date: 2026-10-24 (America/Los_Angeles)

## Skills and extensions

- Hermes: 163 enabled entries (6 hub-installed, 81 bundled, 76 local).
  Hermes' own doctor still reports 5 browser, 12 web, and 8 TUI dependency
  advisories, plus optional integrations without credentials or system tools.
- OpenClaw: 88 skills total; 66 eligible and 22 missing requirements. The
  missing set is mostly optional integrations such as 1Password, Slack,
  Notion, Places, voice, and smart-home tools. Plugin loading is clean after
  the BlueBubbles quarantine: 2 loaded, 0 errors.
- Claude: 22 local skill directories; `claude plugin validate ~/.claude/skills`
  passes. One enabled plugin is installed: `codex@openai-codex` 1.0.2.
- Codex: 10 configured MCP servers, with the stale Unity MCP path now disabled.
  The app-injected `node_repl` server remains enabled because its environment is
  supplied by the desktop runtime; the standalone CLI cannot validate it.
- OpenCode: no MCP servers configured; native auth stores Anthropic, OpenCode
  Console, and OpenRouter entries.
- Aider Desk: no MCP servers or preferred models configured; provider is local
  Ollama.
- Antigravity IDE: MCP config exists and is empty.
- Pi GUI: model store and auth store are empty; no Pi CLI is on PATH.

## Smoke tests

- Ollama is reachable on loopback and successfully generated `OK` with the
  local `gemma3:1b` model.
- Aider Desk's embedded runtime reports aider 0.86.2; its desktop bundle is
  0.88.0.
- OpenCode's local service responds on `127.0.0.1:49374`.
- OmniRoute 3.8.52 reports healthy on loopback. Its protected `/v1/models`
  endpoint returns HTTP 401, confirming that the local gateway access key is
  still not configured. No gateway key was generated automatically.

## Remaining gates

- Claude's four Android MCP tokens are still in native settings because there
  is no safe way to remove them without preserving native desktop injection.
  The store contains only redacted snapshots.
- Codex has three missing archived rollout files and duplicate rollout IDs;
  these are state-database maintenance findings, not config errors, and were
  not destructively pruned.
- Codex has a newer CLI available, but the update was not forced during this
  config-store pass.
- OpenClaw's configured remote gateway remains unreachable; local mode was not
  substituted.
- OmniRoute provider routing remains unconfigured until a gateway access key
  and provider credentials are intentionally entered locally.
