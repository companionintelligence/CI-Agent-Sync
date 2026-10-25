# Companion CLI and TUI bridge

Agent Atlas does not replace the native Companion Hub or Companion Memory
command lines. It gives them one portable entry point and a small set of
cross-system checks so the same operator workflow works from any harness.

## Quick start

```sh
# One combined check of the native Hub and Memory CLIs
./bin/agentctl companion status

# Machine-readable status for an agent or CI job
./bin/agentctl companion status --json
./bin/agentctl companion status --from-1password --json

# Native Companion Hub CLI, passed through unchanged
./bin/agentctl companion hub status local
./bin/agentctl companion hub pool status local

# Native Companion Memory CLI, passed through unchanged
./bin/agentctl companion memory stats --json
./bin/agentctl companion memory doctor --graphql

# Short terminal menu for the common operator checks
./bin/agentctl companion tui
```

`./bin/agentctl tui` is an alias for the TUI. `--once` runs the combined
status check and exits, which is useful in a terminal startup file or a
health-check job:

```sh
./bin/agentctl companion tui --once
```

## What is delegated

| Surface | Native command | Agent Atlas behavior |
| --- | --- | --- |
| Companion Hub | `cihub` | Finds the installed CLI, then falls back to a local `Companion-Hub` checkout and runs `bin/cihub.cjs`. |
| Companion Memory | `ci` | Finds the installed CLI, a built `@ci/cli`, or runs `yarn workspace @ci/cli dev` from a local `CI-Memory` checkout. |
| Combined status | Hub `status` + Memory `doctor --graphql` | Runs both with bounded timeouts and emits a stable JSON envelope. |
| Terminal UI | The same native commands | Provides a read-oriented menu for status, pool, Memory inference, readiness, and an explicitly confirmed redacted backup. |

The native command remains responsible for its own flags, auth, confirmation,
mutation policy, and output. The bridge never shells through a command string;
it passes an argument array to the child process.

## Discovery and portable overrides

Discovery order is deliberately predictable:

| Surface | First choice | Fallbacks |
| --- | --- | --- |
| Hub | `CIHUB_BIN`, then `COMPANION_HUB_CLI` | `cihub` on `PATH`, then `CI_HUB_ROOT` or a workspace checkout |
| Memory | `CI_MEMORY_CLI`, then `COMPANION_MEMORY_CLI` | `ci` on `PATH`, a built CLI, or `CI_MEMORY_ROOT` / workspace checkout |

The workspace root is taken from `CI_ROOT` when present. When it is not set,
the bridge checks the conventional `~/devel/ci` location and the surrounding
workspace of the Agent Atlas checkout. This lets a machine use either the
canonical names (`CI-Hub`, `CI-Memory`) or the product names
(`Companion-Hub`, `Companion-Memory`).

For a Memory endpoint, use `COMPANION_MEMORY_BASE_URL`. The status command
passes it to the native CLI as `--server`; `CI_SERVER_URL` is accepted as a
fallback. API keys remain in the inherited environment or the native CLI's
credential flow. Add `--from-1password` when the key should be injected by
Agent Atlas for one process:

```sh
export COMPANION_MEMORY_BASE_URL=https://companion-memory.localhost
./bin/agentctl companion status --from-1password
./bin/agentctl companion memory --from-1password doctor --graphql
```

Prefer the existing 1Password wrapper rather than putting a key in shell
history. The bridge runs `agent-store with companion-memory -- ...`; the
wrapper maps the value to the native `ci` CLI's `CI_API_KEY` and
`CI_SERVER_API_KEY` names only inside the child process. The bridge does not
read, persist, or print the value.

## Combined status contract

`agentctl companion status --json` returns schema version `1`:

```json
{
  "schema_version": 1,
  "mode": "native_cli_bridge",
  "hub_environment": "local",
  "summary": { "ok": 2, "warn": 0, "error": 0 },
  "services": [
    {
      "id": "companion-hub",
      "status": "ok",
      "exit_code": 0,
      "description": "cihub",
      "detail": "..."
    },
    {
      "id": "companion-memory",
      "status": "ok",
      "exit_code": 0,
      "description": "ci",
      "detail": "..."
    }
  ]
}
```

The child output is bounded and scrubbed for common credential labels before it
enters the envelope. Credential values are never part of the contract. Missing
native CLIs are warnings by default and become exit code `2` with `--strict`;
a native command that runs and fails returns exit code `1`.

## TUI menu

The TUI stays intentionally simple so it works over SSH, in a normal terminal,
and when its input is scripted:

```text
[1] Combined Hub + Memory status
[2] Companion Hub status
[3] Companion Hub pool status
[4] Companion Memory connection
[5] Companion Memory inference
[6] Agent Atlas readiness
[7] Create redacted Agent Atlas backup
[q] Quit
```

The backup item requires typing `BACKUP`. It calls the existing redaction-aware
backup script and does not copy native sessions, OAuth state, device identity,
or credential values.

## Boundaries

This bridge is an operator convenience layer, not a new control plane:

- It does not implement a second Hub API client.
- It does not duplicate the Memory REST or GraphQL client.
- It does not bypass native `cihub` confirmation flags or the Memory CLI's
  capability checks.
- It does not make remote fleet changes from the TUI.
- It does not infer credentials from config files.

For cross-surface readiness and the read-only control-room probes, continue to
use `./bin/agentctl readiness --json` and `./bin/agentctl hub smoke --json` /
`./bin/agentctl memory smoke --json`.
