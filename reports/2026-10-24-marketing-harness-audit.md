# Marketing harness audit — 2026-10-24

## Outcome

The local marketing workflow is now represented as portable policy in the
store. CI-Common and CI-Engineering MCP servers are registered for Claude,
Codex, OpenCode, and VS Code. Metricool is registered in those clients as a
remote OAuth MCP. Hermes remains intentionally lean for the local model, and
OpenClaw is documented as a recipe-only target because its current desktop CLI
does not expose native MCP registration.

No credentials or native auth databases were copied into the store.

## Native client verification

| Client | CI-Common | CI-Engineering | Metricool | Result |
| --- | --- | --- | --- | --- |
| Claude | registered and connected | registered and connected | registered and connected | ready for local MCP use; Metricool still needs account auth |
| Codex | registered | registered | enabled | local servers connected; Metricool reports `Not logged in` |
| OpenCode | connected | connected | needs authentication | config repaired after a truncated registration write |
| VS Code | present in active MCP file | present in active MCP file | present in active MCP file | JSON parsed successfully |
| Hermes | intentionally not enabled in lean local profile | intentionally not enabled | opt-in | avoids oversized local-model context |
| OpenClaw | no native MCP command | no native MCP command | no native MCP command | use the shared workflow and OpenClaw skills |

The two local servers completed `initialize` and `tools/list` JSON-RPC smoke
tests. They are loopback processes and retain their server-side confirmation
guards.

## Repository and runtime gates

- CI-Brand-Studio is clean and its Node 24/pnpm 10 install was repaired from
  the existing lockfile. Typecheck passed, the server suite passed 2,954
  tests, the client suite passed 1,239 tests, and production build passed.
- CI-Common has a user-owned untracked planning document and is 13 commits
  behind its remote; it was not changed.
- CI-Engineering has user-owned modified fleet files and an untracked campaign
  plan and is 32 commits behind its remote; it was not changed.
- CI-Engineering surface tests passed 8/8. Its full suite remains environment-
  gated: the workspace's product checkout/ref set does not match the fixture
  assumptions, and the current video status reports 13 products with no
  rendered cuts in the default output folder.
- Metricool is configured but not authenticated in the local Codex/OpenCode
  status checks. Scheduling and publishing remain blocked until the native
  OAuth flow is completed.

## Portable implementation

- `integrations/mcp/registry.yaml` contains reviewed CI-Common,
  CI-Engineering, and Metricool recipes.
- `workflows/marketing-video.md` defines the shared plan → produce → approve →
  schedule → learn loop and its safety gates.
- `sync/manifest.yaml` distributes the workflow to target repositories without
  copying native app state or credentials.
- VS Code's reviewed MCP example and machine profiles now include the shared
  marketing surfaces.

The remaining end-to-end gate is deliberate: choose one approved product,
start Brand Studio and the video generator, then run a single read-only/status
pass before approving any render, capture, schedule, or publish action.
