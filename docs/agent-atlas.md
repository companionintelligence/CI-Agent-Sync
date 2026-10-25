# Agent Atlas web console

Agent Atlas is the local operator surface for the portable `agent-configs`
store. It is intentionally small: Ruby's standard library serves a static
browser interface and a read-only JSON API, so a new machine does not need a
Node install just to inspect its agent setup.

## Start it

```sh
./bin/agent-atlas --open
```

The default address is `http://127.0.0.1:8787/`. Use `--port` when another
local process owns that port:

```sh
./bin/agent-atlas --port 9090
```

The equivalent `agentctl` entry point is:

```sh
./bin/agentctl atlas --open
```

## What the browser can see

| Route | Purpose | Writes |
| --- | --- | --- |
| `/` | Agent Atlas dashboard | No |
| `/api/overview` | Redacted provider, harness, bundle, and Marketplace inventory | No |
| `/api/check/doctor` | Existing machine doctor JSON | No |
| `/api/check/fleet` | Existing Tailscale/Hub smoke JSON | No |
| `/api/check/marketplace` | Existing Marketplace audit JSON | No |
| `/docs/portable-setup.md` | Local setup guide | No |
| `/healthz` | Server liveness | No |

The API intentionally reads public YAML metadata and invokes existing
read-only probes. It does not read credential values, create 1Password items,
claim a Hub, mutate a fleet node, change an app, or deploy an application.

## Safety boundary

The server binds to loopback by default and rejects non-loopback binds unless
the operator explicitly passes `--allow-remote`. That flag adds no
authentication; use it only on a trusted, isolated network and prefer a
private Tailscale path with an authenticated reverse proxy if remote access is
ever needed.

The GUI is a dashboard, not a replacement for the approval ledger. Use the
CLI for changes:

```sh
./bin/agentctl ledger plan ...
./bin/agentctl ledger approve --id LEDGER_ID --confirm
```

## Development checks

```sh
./bin/agent-atlas --check
ruby scripts/test_atlas_web.rb
```

The fixture test starts an ephemeral local server, verifies the overview API,
docs route, health-safe static response, and `HEAD` support, then shuts it down.
