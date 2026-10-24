# Agent Config Store

This is the local, versionable home for Liam's agent configuration templates,
provider mappings, helper commands, redacted audits, and setup notes.

The upstream reference URL supplied for this project was unavailable on
2026-10-24, so this store is intentionally self-contained and records that
provenance rather than pretending to be a mirror.

## Secret policy

Secrets are never copied into this repository. Provider credentials are stored
in the macOS Keychain under the `agent-configs` service namespace. Tool-specific
OAuth files remain in their native application directories. Audits and config
snapshots redact credential-bearing fields.

Start here:

```sh
./bin/agent-store inventory
./bin/agent-store credentials status
./bin/agent-store audit hermes
./bin/agent-store audit openclaw
./bin/agent-store snapshot
```

Add a provider credential locally, without putting it in chat or a tracked
file:

```sh
./bin/agent-store credentials set anthropic
./bin/agent-store credentials set openai
./bin/agent-store credentials set openrouter
./bin/agent-store credentials set ollama
./bin/agent-store credentials set companion-hub
```

Run a client with a Keychain credential injected only into that process:

```sh
./bin/agent-store with anthropic -- claude
./bin/agent-store with openai -- codex
```

See [docs/audit-checklist.md](docs/audit-checklist.md) for the full review
scope and [reports/2026-10-24-hermes-openclaw.md](reports/2026-10-24-hermes-openclaw.md)
for the first completed phase.
