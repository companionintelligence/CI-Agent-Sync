# Whole-platform and marketplace QA

This workflow makes CI-Engineering's `fleet-qa` capability available with the
same safety rules in Claude, Codex, Hermes, OpenClaw, OpenCode, VS Code, Aider
Desk, Pi, and Antigravity. The implementation lives in the CI-Engineering
MCP; this repository carries the portable policy and credential reference.

## Prepare the local process

Resolve the per-node Hub local-key JSON map from 1Password only for the
fleet-qa process. Never paste it into a chat, checked-in config, shell history,
or a client transcript:

```sh
./bin/agent-store with companion-hub-fleet-qa -- \
  node "$CI_ENGINEERING_ROOT/tools/mcp-server.mjs" --start
```

The MCP launcher may also be started by a client using
`integrations/mcp/registry.yaml`. Keep `CI_ENGINEERING_ROOT` and the Hub root
portable; CI-Engineering accepts `HUB_ROOT`, `COMPANION_HUB_ROOT`, or
`CI_HUB_ROOT` and discovers the local `Companion-Hub` checkout when available.

## Safe sequence

1. Call `fleet_qa_capabilities` and confirm the expected `llm`/`agent` and
   `quick`/`full` modes are present.
2. Call `fleet_qa_readiness` and stop on blocking prerequisites. Treat
   warnings (stale provenance, missing inventory, or missing pool survey) as
   evidence gaps, not as a reason to claim the fleet is healthy.
3. Read `fleet_qa_manifest` to identify the current/last `runId` before
   comparing evidence across agents or machines.
4. Select targets explicitly with `nodes: ["beta-1"]`, a named list, or
   `all: true`. There is no implicit all-fleet default.
5. Call `fleet_qa_status` and `fleet_qa_preflight` for the selected suite.
6. Call `fleet_qa_inventory` and `fleet_qa_pool_scan` to establish model,
   backend, and routing evidence before a run.
7. Run `fleet_qa_start` with `suite: llm` and `mode: llm` first. Use
   `mode: agent` only for the harmless coding/agent probe.
8. Collect `fleet_qa_evidence` or the bounded `fleet_qa_snapshot` and
   preserve the `runId`, manifest, readiness, provenance, and result metadata
   without secrets.
9. For marketplace/platform app validation, use `suite: apps` with `mode:
   quick` or `full`. The request must include `confirm: true`; the dashboard
   service is also armed server-side and remains confirmation-gated.
10. Collect evidence again, then call `fleet_qa_stop` when the test window is
   complete. Use `fleet_qa_reset` only as a local fleet-qa control after the
   current evidence is preserved.

Every node-facing request must carry `nodes` or `all`. `all: true` is an
explicit operator choice and still respects the CI-Engineering roster and
disabled/excluded targets. Read-only status and evidence calls do not prove
that a model, marketplace app, or remote Hub is healthy until their result
payload is inspected.

## Marketplace and platform boundaries

The MCP exposes direct app-suite control, but it does not silently execute
the more invasive journey or pool-drill harnesses. Those remain CLI-only and
must be run with their explicit `--execute` and `--lock` gates after the same
preflight. App install/start, model changes, fleet pairing, publishing, and
deployment still require the client confirmation contract described in
`integrations/hub-operator.yaml`.

For a complete report, retain:

- selected target names and roster revision;
- preflight, inventory, and pool-routing evidence;
- suite/mode, backend/provider, model or app identifier, and timestamps;
- failed checks and the exact next action;
- no API keys, bearer tokens, cookies, OAuth sessions, or native app state.
