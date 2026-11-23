# Android MCP connectors

Each Android device running
[Android Remote Control MCP](https://github.com/danielealbano/android-remote-control-mcp)
serves MCP at `/mcp` on port 8080. Claude Code reaches each device by its
Tailscale name. This page covers how those connectors get their bearer tokens:
from 1Password, through `scripts/setup-android-mcp.sh`.

## What lives where

| Piece | Where it lives |
| --- | --- |
| Token for each device | 1Password, vault `Agent Configs`, item `agent-configs-android-mcp-<slug>`, field `credential` |
| Token on the device | The app's bearer token (Settings → Access in the app, or set over adb) |
| Connector | Claude Code user scope (`~/.claude.json`), with `Authorization: Bearer <token>` |

| Slug | Connector | Tailnet host |
| --- | --- | --- |
| `beam-pro` | `android-beam-pro` | `beam-pro.<tailnet>` |
| `beam-pro-1` | `android-beam-pro-1` | `beam-pro-1.<tailnet>` |
| `tab-s8-ultra` | `android-tab-s8-ultra` | `<tab-s8-ultra-host>.<tailnet>` |
| `tab-s9-ultra` | `android-tab-s9-ultra` | `<tab-s9-ultra-host>.<tailnet>` |

`<tailnet>` stands for your tailnet DNS suffix. Set `CI_TAILNET_DNS_SUFFIX` to it, for example `example-tailnet.ts.net`, and each tablet resolves as its label plus that suffix. A tablet whose tailnet name differs from its label takes `ANDROID_HOST_<SLUG>`, set to the label or the full name, for example `ANDROID_HOST_TAB_S8_ULTRA=<its-tailnet-name>`.

The per-device references are listed in `providers/onepassword.yaml`
(`android-mcp-<slug>`). Items use the API Credential type with the
`agent-configs` tag. The script needs `op` (signed in), `claude`, `jq`, `curl`,
`uuidgen`, and `adb` for `provision`.

## Commands

```bash
./scripts/setup-android-mcp.sh status                       # read-only overview
./scripts/setup-android-mcp.sh store beam-pro --paste       # token copied from the app
./scripts/setup-android-mcp.sh store beam-pro --generate    # new random token
./scripts/setup-android-mcp.sh provision beam-pro --serial <adb-serial>                 # plan
./scripts/setup-android-mcp.sh provision beam-pro --serial <adb-serial> --start --apply
./scripts/setup-android-mcp.sh install                      # plan
./scripts/setup-android-mcp.sh install --apply
./scripts/setup-android-mcp.sh verify                                    # tailnet URLs
./scripts/setup-android-mcp.sh verify --device beam-pro --serial <adb-serial>   # over USB
```

`store --paste` reads the token with echo turned off. `store --generate` makes a
new UUID. Both write a new item through a private temp file. Updating an
existing item passes the value as an argument to `op item edit` for a moment,
because `op` has no template input for edits. `install` and `provision` print a
plan unless `--apply` is given. The script never prints token values.

## First-time setup for a device

1. Make the device reachable. Open Tailscale on the phone so its tailnet name
   resolves, and make sure the MCP server is running (Server tab).
2. Choose where the token comes from:
   - Keep the device's current token: copy it from the app's Server tab, then
     run `store <slug> --paste`.
   - Make 1Password the source: run `store <slug> --generate`, then
     `provision <slug> --serial <adb-serial> --apply` while the device is on USB.
     Any client still holding the old token stops working until `install`
     runs again.
3. Register the connector: `install --apply`.
4. Check it: `verify`. `HTTP 200` means the device accepted the token from
   1Password.

## Reading `verify` output

With `--serial`, the same codes come from the device over USB, so the tailnet is
not needed.

- `HTTP 200`: the token is accepted.
- `HTTP 401`: the device answered but holds a different token. Either paste the
  device's token into 1Password (`store --paste`) or push the 1Password token to
  the device (`provision --apply`).
- `HTTP 000`: no route to the device. Check Tailscale on the phone and on this
  Mac, and check that the server is running.

## Notes

- Claude Code stores the token as a literal in its user config, as it did
  before. Re-run `install --apply` after any token change.
- `claude mcp add` receives the authorization header as an argument while it
  runs, so the token can appear briefly in the process list.
- The server can listen on all interfaces, which also makes it reachable on the
  local network. Bind the app to a specific address if you want tailnet-only
  access.
- `provision` changes the device's bearer token, so clients holding the old
  token stop working. A running server keeps the token it started with, so
  `provision --apply` restarts the server when it is up. `--start` also starts
  a server that is not running.
