# Laptop CEO operator review

Date: 2026-10-24 (America/Los_Angeles)

This review covers the Mac that hosts the portable agent control plane, local
Companion Memory, local Companion Hub, the local model backends, and the
Tailscale-connected Hub fleet. It records only redacted status and does not
copy native auth databases, API keys, or service tokens into Git.

## Readiness snapshot

- All 11 tracked harnesses are installed and have a discoverable config root:
  Hermes, OpenClaw, Claude, ChatGPT, Codex, OpenCode, Aider Desk,
  Antigravity, Pi, VS Code, and Ollama.
- Cross-harness conformance: 29 checks passed, 1 warning, 0 missing clients.
- Control-plane test suite: 6 checks passed, including manifest validation,
  harness smoke, sync tests, process timeout/large-output tests, and Hub and
  Memory fixtures.
- Integrated doctor after the local HTTPS diagnostic fix: 38 checks passed,
  13 warnings, 0 errors.
- VS Code: version 1.143.1, 33 extensions, 8 MCP servers, 2 recorded agent
  plugins, and no stale-path or auto-approval drift detected.

## Live local services

- Companion Hub at `http://127.0.0.1:5002`: liveness, readiness,
  registration phase, and state-drift endpoints returned HTTP 200. `cihub`
  status also reports the local Hub healthy.
- Companion Memory at `https://companion-memory.localhost`: health and
  detailed health returned HTTP 200. The local `make dev` stack is running
  with its database, object store, background services, API, worker, web, and
  Caddy origin available.
- oMLX at `http://127.0.0.1:8000/v1`: authenticated model inventory returned
  HTTP 200 through the existing native secret-store entry.
- Ollama at `http://127.0.0.1:11434`: tags endpoint returned HTTP 200.
- OmniRoute is loopback-bound at `127.0.0.1:20128`, but `/v1/models`
  returns HTTP 401 because its separate gateway credential is not configured.
- OpenClaw's desktop-matched gateway health check passes.

## Tailscale and Hub fleet

The Tailscale identity is online with 27 online peers observed. Anonymous
read-only Hub liveness passed for every currently active target:

| Target | Result |
| --- | --- |
| local | HTTP 200 |
| beta-1 | Tailscale ping + HTTP 200 |
| beta-max | Tailscale ping + HTTP 200 |
| core-3 | Tailscale ping + HTTP 200 |
| core-4 | Tailscale ping + HTTP 200 |

Candidate aliases and operator-excluded or unhealthy nodes remain recorded in
`integrations/fleet/targets.yaml`; the smoke command does not silently expand
the deployment blast radius to them.

## Cloudflare and deployment posture

Wrangler identity verification passed using the laptop's native OAuth session.
The portable store now defines a separate `cloudflare` provider and a
`deployment-admin` capability bundle, but no Cloudflare token is present in
1Password yet. Cloudflare and Hub deployment remain preflighted, explicitly
confirmed, and post-probed; no deployment was performed by this review.

ChatGPT is represented as a first-class desktop harness for review and task
preparation. Its hosted account and native app state are intentionally not
treated as an injectable local/API-key client. Approved commands should run in
Hermes, OpenClaw, Claude, Codex, OpenCode, VS Code, or another local harness
that can receive the reviewed process-local credential injection.

## Remaining gates

1. Authorize the pending 1Password desktop CLI request, then create only the
   scoped items for Companion Memory MCP/intents, Hub MCP, Hub `qa:read`, Hub
   inference, OmniRoute, and Cloudflare as needed.
2. Rerun the authenticated Hub control room. Launch readiness is green only
   when the scoped QA, inference, and MCP checks all pass; anonymous health is
   not enough.
3. Rerun the authenticated Memory intents/MCP probe.
4. Decide whether to clone CI-Portal and CI-Marketplace; the current review
   found them missing while preserving dirty CI-Common, CI-Engineering, and
   CI-Spellbook checkouts.
5. Address the existing Companion Memory development warnings separately:
   upload staging permissions, unhandled event listeners, and GPU residency
   detection. These are service/runtime warnings, not control-plane changes.

The repeatable entry points are `./bin/agentctl doctor --json`,
`./bin/agentctl conformance --json`, `./bin/agentctl test --json`,
`./bin/agentctl hub smoke --json`, `./bin/agentctl memory smoke --json`,
`./bin/agentctl fleet smoke --json`, and
`./bin/agentctl deploy doctor --json`.
