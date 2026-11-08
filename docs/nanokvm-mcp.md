# NanoKVM MCP setup

CI Agent Sync includes NanoKVM MCP entries for the six supplied Tailscale
devices. The registry stores DNS endpoints and environment-variable names;
the private API keys remain on the local machine.

## Set up Claude Code and Codex CLI

From the CI-Agent-Sync checkout, run:

```sh
./scripts/setup-nanokvm-mcp.sh
```

By default, the script prompts for an API key for each device without
displaying the characters. It stores the values in
`${XDG_CONFIG_HOME:-~/.config}/ci-agent-sync/nanokvm.env` with mode `600`,
registers each server in the selected client’s user-level MCP config, and
creates wrappers under `~/.local/bin` that load the private key file before
starting the client.

To set up core-14 first, or configure only a subset of devices, pass one or more
device hostnames:

```sh
./scripts/setup-nanokvm-mcp.sh --device core-14-kvm
./scripts/setup-nanokvm-mcp.sh --device core-14-kvm --device core-17-kvm
```

Start a terminal session with the configured servers using:

```sh
~/.local/bin/nanokvm-claude
~/.local/bin/nanokvm-codex
```

To configure only one client, pass `--clients claude` or `--clients codex`.
Run with `--refresh-keys` to replace keys for the selected devices. Re-running
setup replaces only the selected `nanokvm-*` server entries created by this
tool and keeps saved keys for unselected devices.

The registered endpoints are:

| Server | MCP endpoint |
| --- | --- |
| `nanokvm-beta-ms-a2-kvm` | `https://beta-ms-a2-kvm.capybara-ulmer.ts.net/api/mcp` |
| `nanokvm-core-14-kvm` | `https://core-14-kvm.capybara-ulmer.ts.net/api/mcp` |
| `nanokvm-core-17-kvm` | `https://core-17-kvm.capybara-ulmer.ts.net/api/mcp` |
| `nanokvm-core-4-kvm` | `https://core-4-kvm.capybara-ulmer.ts.net/api/mcp` |
| `nanokvm-core-5-kvm` | `https://core-5-kvm.capybara-ulmer.ts.net/api/mcp` |
| `nanokvm-core-7-kvm` | `https://core-7-kvm.capybara-ulmer.ts.net/api/mcp` |

NanoKVM MCP uses the `Authorization: Bearer <API-Key>` header. Generate and
manage each device's key in its NanoKVM API configuration, following the
[Sipeed NanoKVM MCP guide](https://wiki.sipeed.com/hardware/en/kvm/NanoKVM/mcp.html).
The machine must be connected to the `capybara-ulmer.ts.net` tailnet for these
endpoints to resolve. Claude Code expands custom environment variables in
remote MCP headers, and Codex CLI can read a bearer token from an environment
variable; the wrappers supply those values at launch. See the
[Claude Code MCP docs](https://code.claude.com/docs/en/mcp) and
[Codex MCP docs](https://developers.openai.com/codex/extend/mcp).

## Device-control policy

The `nanokvm` capability bundle is opt-in and marked high-risk because it can
control the remote keyboard, display, power, and virtual media. Check the
server name before acting, especially before mounting an ISO or changing power
state. The setup script configures access; it does not connect to devices,
mount media, or install an operating system.

The public registry intentionally contains Tailscale DNS names only. It does
not publish the supplied device-owner email, fixed Tailscale IPs, firmware
versions, or live connection status.
