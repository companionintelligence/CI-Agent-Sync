# Portable agent control plane

`agent-configs` is the declarative layer shared by ChatGPT, Hermes, OpenClaw,
Claude, Codex, OpenCode, Aider Desk, Pi, Antigravity, VS Code, Ollama, and local model
servers. It stores policy and reproducible recipes, not native app state.

## Lifecycle

1. `agentctl inventory` discovers clients, apps, and config roots.
2. `agentctl doctor --json` checks command availability, config presence,
   secret-store presence, endpoint reachability, and workspace drift.
3. `agentctl test --live-local` runs manifest validation, harness smoke checks,
   a gateway check when available, and a harmless local coding request.
4. `agentctl conformance --json` produces the current harness/provider
   convergence matrix without printing credentials.
5. `agentctl hub smoke --json --strict --from-1password` runs the read-only
   Companion Hub control room: health, registration, qa-read surfaces,
   inference inventory, MCP tool discovery, and local CLI status.
6. `agentctl backup` creates a timestamped redacted recovery bundle.
7. `agentctl memory smoke`, `agentctl fleet smoke`, and `agentctl deploy doctor`
   verify the local Memory origin, Tailscale Hub targets, and Cloudflare/Hub
   deployment identity without performing a write.
8. `agentctl render` generates portable VS Code, workspace, and Aider Desk
   artifacts under ignored `local/rendered/`.
9. `agentctl sync` distributes only the reviewed manifest into clean target
   repositories. Applying a sync creates a local rollback backup first.

## Three separate stores

- **Tracked policy:** providers, fallback chains, MCP recipes, capability
  bundles, skills, plugins, workflows, and redacted snapshots.
- **Portable secrets:** 1Password CLI items referenced by `op://` paths. The
  macOS Keychain/Linux Secret Service copies are migration fallbacks only, and
  each client's native OAuth store remains local. Values never enter Git or
  command output.
- **Native state:** sessions, transcripts, model caches, device state, and app
  databases. These remain on the machine that owns them.

## MCP bundles

Bundles in `integrations/capability-bundles.yaml` keep the same reviewed
capabilities available across clients without making every client powerful by
default. `core` is read-oriented; `development` adds engineering helpers;
`marketing` connects Brand Studio, CI-Common, CI-Engineering, and Metricool;
`mobile` is high-risk and must be selected deliberately.

Every remote service still needs a local endpoint and native credential. A
registered MCP server is not proof that transport, authentication, and tools
are working.

Companion Hub credentials are intentionally split by blast radius:

- `companion-hub` is an `mcp` key for MCP handshake and tools.
- `companion-hub-qa` is a `qa:read` key for pool, routing, app-status, and
  install-queue observability.
- `companion-hub-inference` is an `inference` key for model inventory and
  harmless OpenAI-compatible coding probes.

Full/admin credentials stay out of the default portable profile. Any write
workflow must name its target, show the read-only preflight, state rollback,
obtain confirmation immediately before the mutation, and re-run the control
room afterward.

## Recovery

If a client breaks, stop the client, run `agentctl backup`, fix the smallest
native config, and run `agentctl doctor` followed by `agentctl test`. For
OpenClaw, preserve the gateway identity and use the app's reset-remote-tunnel
flow only when the gateway reports a persisted-device-identity or tunnel
ownership error. Never replace identity or session databases with a portable
snapshot.
