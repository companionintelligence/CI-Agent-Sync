# IP-KVM MCP wiring (NanoKVM and PiKVM)

This page is the operator runbook for letting coding agents see and drive the
machines behind the tailnet IP-KVM dongles. The inventory is
[`integrations/kvm/targets.yaml`](../integrations/kvm/targets.yaml). The key
map is [`integrations/kvm/op.env.example`](../integrations/kvm/op.env.example).

Device control is high risk. An agent that holds a KVM key can click, type and
reboot the controlled host. Treat every enabled client as a privileged operator.

## Check the devices (read-only)

```sh
./bin/agentctl kvm targets
./bin/agentctl kvm status            # GET only, no credentials
./bin/agentctl kvm status --strict   # exits 2 while any device still needs setup
```

Reading the status column:

| Result | Meaning | What to do |
| --- | --- | --- |
| `mcp=enabled_auth_required` | `/api/mcp` answers 401 — MCP is on and wants a key | Copy the key into 1Password (below) |
| `mcp=disabled_or_blocked` | `/api/mcp` answers 403 | Turn on the MCP switch in the device's web UI, then re-run |
| `mcp=not_in_firmware` | `/api/mcp` answers 404 | Update the NanoKVM app and firmware |
| `mcp=enabled_unauthenticated` | `/api/mcp` answers 200 with no key | Stop and review before any client connects |
| PiKVM `ok` | `/api/info` answers 401 | Authenticate through the PiKVM MCP env below |

## Per-device setup (NanoKVM)

Repeat for each device you want an agent to control. Start with the ones that
are not excluded in `targets.yaml`.

1. Open the device's web UI at its tailnet name (for example
   `https://core-14-kvm`), and log in with the admin account. Do not store that
   password in this repository.
2. Find the **MCP** switch, turn it on, and note the **Endpoint** and **API
   Key** the page shows. Copy the endpoint exactly as shown.
3. Create a 1Password item in the `Agent Configs` vault named
   `agent-configs-kvm-<target>` with a `credential` field holding the API key.
   The target name is the key in `targets.yaml`, for example
   `agent-configs-kvm-core-14-kvm`.
4. Create the local env file (gitignored) and print the client config:

   ```sh
   cp integrations/kvm/op.env.example local/kvm.env
   ./bin/agentctl kvm mcp core-14-kvm --scheme https
   ```

   Use `--scheme http` for devices that answer on HTTP.
5. Launch the client through 1Password so the key is injected at start and is
   never written to disk:

   ```sh
   op run --env-file local/kvm.env -- opencode
   ```

   Inside the client, run `opencode mcp list`. `nanokvm-<target>` should show as
   connected.

For HTTPS devices with the local self-signed certificate, OpenCode may need
`NODE_TLS_REJECT_UNAUTHORIZED=0`. The Sipeed guide documents this. Use it only
on the tailnet, and prefer the HTTP endpoint when the device offers one.

## Excluded and blocked hosts

`excluded_from_mcp: true` marks a device that must not be given a client, even
though the probe still runs. The generator refuses to print a config for it.
Today that covers `core-5-kvm` (host key changed) and `core-7-kvm` (operator
exclusion). Note that `core-7-kvm` already answers 401 on `/api/mcp`, so MCP is
on there. Someone enabled it, so find out who before anything else connects.

Do not add a key for an excluded device, even if the 1Password item exists.

## PiKVM (beta-kvm-1, beta-kvm-2)

The PiKVM server is `KultivatorConsulting/pikvm_mcp_server`, pinned in
`integrations/mcp/registry.yaml` to `a859da7`. Install it once:

```sh
git clone https://github.com/KultivatorConsulting/pikvm_mcp_server "$PIKVM_MCP_ROOT"
git -C "$PIKVM_MCP_ROOT" checkout a859da7a7d9f2679e7728da46c387c24e5348296
(cd "$PIKVM_MCP_ROOT" && npm install && npm run build)
```

Put the PiKVM admin password in `agent-configs-kvm-beta-kvm-1` (field
`credential`) and map it as `PIKVM_BETA_KVM_1_PASSWORD` in `local/kvm.env`. Set
`PIKVM_HOST=https://beta-kvm-1` and `PIKVM_USERNAME=admin`. The registry entry
is a template; create one client entry per device rather than sharing one.

The PiKVM MCP server moves the real mouse and keyboard. Keep the client's
tool-approval prompts on.

## What is not automated here

- Enabling the NanoKVM MCP switch and reading the key require logging into each
  device. Do this yourself, or approve a browser session that uses 1Password
  autofill.
- `controls` in `targets.yaml` is a naming inference (`<node>-kvm` controls
  `<node>`). Confirm it on each device before trusting it for a fleet action.
- Tailnet identity drifts. `100.105.166.78` was once recorded as `fzzy`. It now
  answers as `core-14-kvm`. Match by tailnet name, and check the device's own
  hostname before acting.
