# Integrated agent control plane

Date: 2026-10-24 (America/Los_Angeles)

The store now has an executable integration layer rather than only static
configuration examples.

## Added

- `agent-store render` generates ignored, safe artifacts for VS Code, all
  Companion Intelligence workspace folders, and client launch notes. It never
  writes native agent databases or OAuth state.
- `agent-store doctor` checks installed clients, config presence, secret-store
  presence, manifest parsing, MCP syntax, Ollama reachability, OmniRoute
  binding/auth, optional Companion Memory health, and repository presence/dirty
  state. `--json` is suitable for CI or a dashboard.
- `agent-store repos sync` is plan-only by default. `--apply` fetches and
  fast-forwards only clean checkouts; dirty and detached repositories are
  skipped.
- `integrations/providers/routing.yaml` defines local Ollama, loopback
  OmniRoute, Companion Memory, and remote-provider policy without credentials.
- `repos/workspace.yaml` captures the parent CI workspace layer map, aliases,
  stack/package-manager expectations, and sync safety rules.
- macOS, Linux, and Windows machine profile examples now separate paths,
  capabilities, and credential-store expectations.
- Shared provider injection supports macOS Keychain and Linux Secret Service;
  Windows remains native-client-only until a reviewed credential backend is
  selected.

## Evidence from this machine

- Generated a full workspace with 38 mapped folders and a local-only workspace
  with 28 existing folders.
- Doctor completed with 28 healthy checks, 9 warnings, and 0 errors.
- Ollama returned HTTP 200 on its local tags endpoint.
- OmniRoute remains loopback-bound but its models endpoint returns HTTP 401,
  so routing is correctly reported as protected rather than operational.
- The Companion Memory URL is not configured on this machine, so shared-memory
  health is reported as a warning.
- Repository sync planning preserved dirty CI-Common and CI-Spellbook
  checkouts and identified missing core checkouts without changing them.

## Deliberate boundaries

The integration layer does not generate an OmniRoute access key, copy OAuth
files, enable every MCP server, install unreviewed plugins, or overwrite
native client configuration. Those operations remain explicit and local.
