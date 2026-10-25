# CI Agent Sync setup wizard

CI Agent Sync is the local setup surface for this portable store. It is a
small TypeScript/Node 22 service that serves a static, mobile-first browser
wizard and a JSON API. It intentionally has no frontend framework or
long-running dependency beyond the local process and the pinned YAML parser.

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

## Wizard flow

| Step | What happens |
| --- | --- |
| 1. Start | Explains the portable/local boundary |
| 2. Vault | Copies the safe 1Password setup commands |
| 3. Agents | Selects the harnesses to keep in the portable plan |
| 4. Profile | Chooses CEO, engineering, or marketing policy |
| 5. Backup | Previews and creates a redacted native-config backup |
| 6. Ready | Shows the next CLI checks and sync commands |

The profile step can generate the ignored `local/rendered/` artifacts for every
supported agent. The backup step can create a timestamped redacted snapshot in
`local/backups/`. Both are fixed allowlisted actions; the browser cannot run an
arbitrary shell command.

## What the browser can see

| Route | Purpose | Writes |
| --- | --- | --- |
| `/` | Mobile-first setup wizard | No |
| `/api/overview` | Redacted provider, harness, bundle, profile, and Marketplace inventory | No |
| `/api/check/backup-plan` | Preview available agent config files | No |
| `/api/check/doctor` | Existing machine doctor JSON | No |
| `/api/check/fleet` | Existing Tailscale/Hub smoke JSON | No |
| `/api/check/marketplace` | Existing Marketplace audit JSON | No |
| `/api/action/render` | Generate ignored portable artifacts for all agents | Yes, local only |
| `/api/action/backup` | Create a redacted native-config snapshot | Yes, local only |
| `/docs/portable-setup.md` | Local setup guide | No |
| `/healthz` | Server liveness | No |

The API intentionally reads public YAML metadata and invokes the typed
operations in `src/operations.ts`. The two write routes are fixed, allowlisted
actions with an explicit JSON
`confirm: true` body. They do not read credential values, create 1Password
items, claim a Hub, mutate a fleet node, change an app, or deploy an
application.

## Safety boundary

The server binds to loopback by default and rejects non-loopback binds unless
the operator explicitly passes `--allow-remote`. That flag adds no
authentication; use it only on a trusted, isolated network and prefer a
private Tailscale path with an authenticated reverse proxy if remote access is
ever needed.

The wizard is not a replacement for the approval ledger. Use the CLI for
fleet, deployment, Hub, or repository changes:

```sh
./bin/agentctl ledger plan ...
./bin/agentctl ledger approve --id LEDGER_ID --confirm
```

## Development checks

```sh
npm install
npm run build
./bin/agent-atlas --check
./bin/agentctl check
```

The TypeScript check compiles the control plane and browser source, validates
the store manifests, and checks the vendored CI-Common assets. Use the
TypeScript-backed diagnostics for normal operation:

```sh
./bin/agentctl doctor --json
./bin/agentctl conformance --json
./bin/agentctl harness-smoke --json
```

The legacy Ruby fixture remains available for compatibility coverage while
specialized Ruby commands are being ported.
