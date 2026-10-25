# Reliability contract

CI Agent Sync is a control plane for native agent clients, local model
servers, Companion Memory, Companion Hub, and the Tailscale fleet. A rendered
file or registered MCP is not considered healthy by itself.

## Health states

Every probe should distinguish these states:

| State | Meaning |
| --- | --- |
| `not-installed` | The command or desktop application was not found. |
| `installed` | The client is present, but its configuration has not been verified. |
| `configured` | The expected config or MCP recipe is present. |
| `authenticated` | The required credential or native login was accepted. |
| `reachable` | The endpoint answered within the bounded probe timeout. |
| `functional` | A harmless capability test completed successfully. |
| `degraded` | The service is usable with a warning, such as an optional provider being offline. |
| `blocked` | A required dependency or approval is missing. |

The CLI must never collapse `reachable`, `authenticated`, and `functional`
into one green result. For example, a local Memory GraphQL endpoint returning
`401 Unauthorized` is reachable but not authenticated; an MCP entry in a
generated config is configured but not necessarily connected.

## Bounded execution

Diagnostics and MCP probes must be bounded:

- child processes have a timeout and a maximum captured output size;
- asynchronous web checks must not block the Node event loop;
- POSIX process groups are terminated together when a probe times out;
- HTTP checks use a short connection/read timeout and retry only transient
  service-startup responses;
- authentication and configuration errors are not retried as if they were
  network failures;
- JSON output includes enough timing and error metadata to explain a failure,
  but never includes credential values.

Use the existing commands to inspect a machine:

```sh
./bin/agentctl doctor --json
./bin/agentctl companion status --json --timeout 20
./bin/agentctl test
./bin/agentctl conformance --json --timeout 15
./bin/agentctl harness-smoke --json --timeout 12
./bin/agentctl fleet smoke --json
```

## Companion service discovery

The bridge prefers this order:

1. an explicitly configured CLI (`CIHUB_BIN`, `CI_MEMORY_CLI`);
2. an installed native CLI (`cihub`, `ci`);
3. a built local checkout;
4. a source checkout using its native package-manager entry point.

The source-checkout path matters during development. A running Companion
Memory API with an unbuilt CLI should report an authentication or API result,
not “CLI missing.” Hub and Memory status checks run concurrently so one slow
surface cannot hide the other.

The doctor uses these local development defaults when no machine overlay or
environment variable is present:

- Companion Hub: `http://127.0.0.1:5002`
- Companion Memory: `http://127.0.0.1:3030`

These defaults are probes only; they do not start containers, change bindings,
or imply that a service is authenticated. Set `COMPANION_HUB_BASE_URL`,
`COMPANION_MEMORY_BASE_URL`, or `CI_SERVER_URL` for a different target.

## Web wizard safety

The loopback wizard has these reliability boundaries:

- startup errors, including port collisions, return a clear non-zero result;
- `SIGINT` and `SIGTERM` close the HTTP server cleanly;
- read-only checks return a failing HTTP status when the check fails;
- action bodies are capped at 64 KiB;
- write actions remain explicit-confirmation only;
- the wizard remains loopback-only unless `--allow-remote` is supplied.

The wizard does not repair native app state, copy OAuth sessions, claim device
identities, restart fleet nodes, or deploy applications implicitly.

## Reliability testing

The repository test suite covers both the happy path and failure boundaries:

```sh
npm run build
npm test
./bin/agentctl conformance --json --timeout 15
./bin/agentctl harness-smoke --json --timeout 12
./bin/agentctl check
```

Live tests should be run separately because they depend on the laptop's
current credentials and service state:

```sh
./bin/agentctl harness-smoke --json --live-local --timeout 20
./bin/agentctl companion status --json --timeout 20
```

An optional local model or gateway being stopped is a warning unless the
selected profile requires it. A failed required model, MCP, Memory, Hub, or
deployment preflight is a blocker and must include a next action.

## Evidence and recovery

Reliability claims should be backed by a timestamped JSON result containing:

- source commit;
- machine and environment;
- harness/provider/MCP identifier;
- probe type and timeout;
- redacted result;
- elapsed time;
- repair or approval required;
- follow-up verification result.

Before native repairs:

```sh
./bin/agentctl backup
./bin/agentctl doctor --json
```

Preserve native OAuth stores, OpenClaw device identities, desktop databases,
and model caches. Portable backups contain policy and redacted configuration,
not runtime identity.
