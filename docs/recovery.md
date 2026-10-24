# Recovery runbook

Use this sequence when a desktop harness, gateway, or local model appears
busted:

```sh
./bin/agentctl backup
./bin/agentctl doctor --json
./bin/agentctl test
```

Backups are redacted and stored below `local/backups/`. They do not contain
OAuth sessions, native app databases, device identities, or provider keys.

For a service that is reachable but unauthenticated, set the credential through
the native store and retry the health check. Do not paste it into a config file:

```sh
./bin/agentctl credentials set omlx
./bin/agentctl credentials status
```

For OpenClaw, stop the desktop app before repairing its gateway state. Preserve
the existing identity and session database. If the dashboard says it cannot
claim a persisted device identity, use **Debug → Reset Remote Tunnel**, then
reconnect to the local loopback gateway and rerun `agentctl test --live-local`.

When the desktop app and standalone CLI are different releases, use the
desktop-matched wrapper if one exists. A schema migration needs the gateway
stopped first; the wrapper's `doctor --fix --non-interactive` keeps the
pre-repair capture and the existing device identity, then the gateway must be
started again before health testing.

For sync failures, inspect the plan first. Applying a plan to a clean checkout
creates a timestamped backup before an existing file is replaced or an
explicit deletion is applied.
