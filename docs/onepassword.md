# 1Password credential portability

The shared credential backend is 1Password CLI (`op`). Git stores only
`op://` references and provider metadata. Values, sessions, and service-account
tokens stay in 1Password or the machine's native auth environment.

## One-time setup

1. Open 1Password and enable **Settings → Developer → Integrate with 1Password
   CLI**.
2. Authenticate the CLI with `op signin`.
3. Create or verify the vault and import the existing native copies:

```sh
./bin/agentctl credentials op setup
./bin/agentctl credentials op import
./bin/agentctl credentials op status
```

The desktop app must be unlocked for the first CLI approval. On macOS,
1Password shows an **Allow ChatGPT to get CLI access** dialog; approve it with
Touch ID, then rerun the commands. Probes fail fast while that dialog is
waiting and never print credential values.

Import keeps the Keychain/Secret Service copy by default so each provider can
be tested before removing local migration copies. Only after verification, and
only if desired, run:

```sh
./bin/agentctl credentials op import --remove-native
```

The import command streams each value directly into the 1Password CLI. It does
not place values in arguments, files, Git, or chat output.

## Runtime behavior

`AGENT_CONFIGS_SECRET_BACKEND=1password` is the default. `agent-store with`
and the health checks resolve the 1Password item first, then use the native
copy only while `AGENT_CONFIGS_ALLOW_NATIVE_FALLBACK=true`. After migration,
set that fallback to `false` on the machine or shell profile.

The vault defaults to `Agent Configs`; override it without changing tracked
references with `AGENT_CONFIGS_OP_VAULT`. Item names are predictable and scoped
with the `agent-configs` tag:

```text
agent-configs-anthropic
agent-configs-openai
agent-configs-openrouter
agent-configs-ollama
agent-configs-omlx
agent-configs-companion-hub
agent-configs-companion-hub-qa
agent-configs-companion-hub-inference
agent-configs-companion-hub-fleet-qa
agent-configs-companion-memory
agent-configs-omniroute
agent-configs-android-mcp
agent-configs-cloudflare
```

## Hermes

Hermes has a native mapped 1Password source. Use
`agents/hermes/onepassword-secrets.example.yaml` in the active profile. It
resolves the same references at process startup and supports either desktop
integration or a headless `OP_SERVICE_ACCOUNT_TOKEN` supplied by the machine's
secret manager.

## Other harnesses

For Claude, Codex, OpenCode, OpenClaw, Aider Desk, Pi, Antigravity, and VS Code,
use `agent-store with <provider> -- <command>` or the client’s native
environment/reference support. The shared wrapper keeps credentials process-
local and avoids writing them into native config files. Native OAuth flows such
as Metricool remain in the client’s own auth store.

Deployment credentials are separate from model and Hub keys. Store a
target-scoped Cloudflare API token as `agent-configs-cloudflare`; the portable
workflow injects it only for an explicit Wrangler command. Do not copy the
current laptop’s native Wrangler OAuth file. Hub fleet credentials should be
scoped per target when the appliance does not share one owner/key namespace.
For CI-Engineering fleet-qa, store the one-line JSON object of reviewed node
local keys in `agent-configs-companion-hub-fleet-qa`; never commit or echo the
object. The wrapper injects it as `FLEET_HUB_API_KEYS_JSON` only for the
fleet-qa process.

Never commit a service-account token, `OP_SESSION_*` value, exported `.env`, or
resolved secret. Rotate a provider in 1Password first, rerun `status`, then
restart only the clients that cache credentials.
