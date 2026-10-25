# CEO and Companion Hub operator workflow

This workflow gives every harness the same operating contract for Companion
Hub administration. It is intentionally read-first: the agent may collect
evidence and prepare a change, but it must not mutate apps, models, fleet
pairings, registrations, backups, accounts, publishing, or schedules without
an explicit confirmation immediately before the write.

## Start every session with the control room

From `agent-configs`:

```sh
./bin/agentctl hub smoke --json --strict --from-1password
```

The command checks liveness, readiness, registration phase and drift, the
read-only Hub Pool surface, inference model inventory, MCP initialize/tool
discovery, and the local `cihub status` summary. It never prints credentials or
response bodies. Without scoped keys it still checks anonymous health and
reports the missing capability as a warning.

For the full local operating surface, run the adjacent read-only probes too:

```sh
./bin/agentctl memory smoke --json
./bin/agentctl fleet smoke --json
./bin/agentctl deploy doctor --json
```

The Memory probe uses the local `https://companion-memory.localhost` origin
created by `make dev` unless `COMPANION_MEMORY_BASE_URL` is set. Fleet smoke
uses the Tailscale names in `integrations/fleet/targets.yaml`; it checks
anonymous liveness only, so authenticated QA/inference/MCP checks still need a
scoped key for each target.

Recommended scoped 1Password items:

| Item | Scope | Use |
| --- | --- | --- |
| `agent-configs-companion-hub` | `mcp` | MCP initialize and approved tools |
| `agent-configs-companion-hub-qa` | `qa:read` | Pool, routing, app-status, install-queue reads |
| `agent-configs-companion-hub-inference` | `inference` | OpenAI-compatible model inventory and coding probes |
| `agent-configs-companion-hub-fleet-qa` | `qa:read` JSON map | Per-node fleet-qa pool-routing evidence |

Create them on the Hub host with the least scope needed, then store each raw
value once in 1Password. Do not put a full/admin key in the default portable
profile.

## CEO admin change contract

For any requested change, the harness must produce this sequence:

1. State the exact object: Hub, app URN, model, pool peer, registration, backup,
   account, post, or schedule.
2. Run the control-room probe and read the relevant status surface.
3. Explain the proposed state change, blast radius, and rollback path.
4. Ask for confirmation immediately before the write.
5. Perform one scoped mutation only.
6. Re-run the control-room probe and record the resulting operation/job id.

High-risk examples include app install/update/restart, model load/unload or
pinning, pool pair/approve/unpair, registration reset, restore/delete, API-key
or role changes, marketplace publication, and Metricool publish/schedule.

## Launch readiness

Do not call the Hub ready for agent work unless all four gates are green:

- health: liveness and readiness are reachable;
- operator read: the `qa:read` checks show the pool and install queue;
- inference: a chat model is listed through the inference-scoped key;
- tools: MCP initializes and advertises a non-empty tool set.

An authenticated `401` or `403` is a failed gate, not a transient warning. A
missing credential is a configuration warning and must be fixed before remote
agent tools are enabled.

## Incident recovery

Capture the JSON report before repairing. Preserve logs and identity state.
Back up before reset or restore, change one failure domain at a time, and run
the same report after the repair. If identity, registration, or data integrity
is uncertain, stop and escalate rather than recreating state.

## Harness parity

Use the same harmless coding prompt across Hermes, OpenClaw, Claude, Codex,
OpenCode, Aider Desk, Pi, Antigravity, and VS Code. Record only provider/model,
latency, response shape, and pass/fail. Keep MCP bundles and tool permissions
consistent with `integrations/capability-bundles.yaml`; use local-first routing
for drafts and require an approval boundary for downstream marketing writes.
