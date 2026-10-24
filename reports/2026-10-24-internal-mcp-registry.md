# Internal MCP registry — 2026-10-24

The internal MCP catalog now covers the requested Companion Intelligence
surfaces without copying native credentials or pretending that an unconfigured
endpoint is connected.

| Server | Transport | Reviewed entrypoint | Credential / gate |
| --- | --- | --- | --- |
| Companion Hub | Streamable HTTP | `${COMPANION_HUB_BASE_URL}/api/mcp` | Hub MCP key, `mcp` scope, `read` by default |
| Companion Memory | Streamable HTTP | `${COMPANION_MEMORY_BASE_URL}/api/mcp` | Memory key with `mcp` + `intents`, `read` by default |
| CI-Brand-Studio | stdio | `${CI_BRAND_STUDIO_ROOT}/asset-engine/apps/dashboard/mcp.mjs --start` | loopback dashboard; writes, approvals, services, and renders require confirmation |
| CI-Engineering | stdio | `${CI_ENGINEERING_ROOT}/tools/mcp-server.mjs --start` | loopback product-video/engineering MCP; server-side confirmation |

## Source review

- Companion Hub's checked-out MCP bootstrap documents `/api/mcp` with bearer
  authentication and a separately minted key; `cihub mcp setup` alone does not
  create a credential.
- Companion Memory's current MCP docs distinguish its external `/api/mcp`
  edge path from the direct internal `/mcp` route and require `mcp` plus
  `intents` for a useful scope-limited tool list.
- CI-Brand-Studio's current `origin/main` contains the Asset Engine dashboard
  MCP server. The local checkout is 29 commits behind, so the recipe is
  portable and reviewed but was not launched from the stale checkout.
- CI-Engineering already exposes the reviewed stdio server and remains
  confirmation-gated.

## Machine state

Portable recipes and examples were updated for VS Code, Aider Desk, Claude's
reviewed MCP inventory, and the shared registry. Native clients were not
silently edited to point at unavailable services. This machine currently has
no Companion Hub or Companion Memory credential in the native secret store, so
authenticated HTTP handshakes remain pending until the user configures the
two keys locally.
