# Hermes and OpenClaw audit

Date: 2026-10-24 (America/Los_Angeles)

## Hermes

Verified Hermes Agent v0.20.4. The Python environment, core packages, SQLite
state, install entry point, skills directory, memory store, and OpenAI Codex
OAuth are healthy. The active model is a local custom endpoint at
`http://127.0.0.1:8000/v1`.

Repairs applied:

- migrated the deprecated compression summary settings into
  `auxiliary.compression`;
- moved the deprecated messaging working directory into `terminal.cwd`;
- removed the deprecated empty display override;
- removed the deprecated `MESSAGING_CWD` environment variable;
- created a timestamped local config backup before editing.

Post-repair `hermes doctor` reports no deprecated config keys or environment
variables. Remaining findings are dependency advisories in browser/web/TUI
workspaces, optional missing integrations, no OpenRouter credential, no
GitHub token for higher registry limits, and an installed-but-stopped Hermes
gateway LaunchAgent. These are intentionally not solved by inventing or
requesting credentials.

## OpenClaw

Verified OpenClaw 2026.2.12. The active configuration uses a loopback-bound
remote-gateway mode targeting a gateway on another machine. The target refused
the current connection, so local health cannot be claimed. The local gateway
service is not installed, which is consistent with the remote mode and was not
changed.

Repairs applied:

- disabled the stale local BlueBubbles plugin entry;
- quarantined the duplicate local BlueBubbles extension outside OpenClaw's
  extension discovery path at `~/.openclaw-disabled/bluebubbles-20261024`;
- added an explicit plugin allowlist preserving `imessage` and `memory-core`;
- created a timestamped local config backup before editing.

Post-repair `openclaw doctor --deep --non-interactive` reports zero plugin load
errors and no duplicate-plugin warning. The remaining runtime gate is the
unreachable remote gateway. iMessage remains disabled and pairing-protected;
the quarantined BlueBubbles copy is recoverable if that channel is intentionally
restored later.
