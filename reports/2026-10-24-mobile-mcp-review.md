# Mobile MCP review — 2026-10-24

## References reviewed

- Private planning document: [Companion SCAN and Mobile MCP](https://docs.google.com/document/d/1ige6RttbZQoedl589-OXPmZ3kIZunat6PUzVnm4cCeU/edit?tab=t.0)
- Public implementation: [danielealbano/android-remote-control-mcp](https://github.com/danielealbano/android-remote-control-mcp)

The Google Doc is catalogued as a link-only private reference. It contains
device-specific endpoints and credential-bearing examples; none of those values
were copied into this repository.

## Implementation review

The Android project is a Kotlin app that hosts a Streamable HTTP MCP endpoint
at `/mcp` on the Android device. It supports UI inspection and actions,
screenshots, gestures, text input, app management, files, camera,
notifications, location, and sharing. It uses Android Accessibility for core
control and supports bearer-token or OAuth authentication, optional HTTPS, and
optional tunnels.

The portable store records it as an opt-in high-risk MCP. The default recipe
uses `http://127.0.0.1:8080/mcp` with `adb forward` as the preferred host
connection. A public tunnel or network binding must be an explicit decision.
The bearer token is entered locally with:

```sh
./bin/agent-store credentials set android-mcp
```

The value is injected only as `ANDROID_MCP_TOKEN`; it is never stored in the
repository or imported from the planning document.

## Remaining setup gates

- Install and verify the GMS or FOSS APK on a selected Android device.
- Grant Accessibility only after confirming the device and intended control
  scope.
- Start with a minimal tool permission set and loopback/ADB forwarding.
- Complete a read-only `initialize`/`tools/list` smoke test before enabling any
  device mutation, file, camera, notification, or tunnel capability.
- Confirm the target client supports Streamable HTTP and the selected auth
  method before adding it to a native client configuration.

No Android device was connected or modified during this review.
