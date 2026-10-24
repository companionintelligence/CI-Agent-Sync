# CI-Hub fleet and harness repair

Date: 2026-10-24

## Scope

- Repaired core-3's Companion Hub data-directory ownership mismatch.
- Preserved the host `cihub` CLI's ability to read its device key after the
  container bind mounts were corrected.
- Left core-7 and fzzy untouched by explicit operator request.
- Left core-5 untouched because strict SSH host-key verification blocked safe
  administration.

## Core-3 result

The ten Companion Hub bind-mount directories now pass the Hub's UID/GID check
for the container's `1000:1000` runtime. The settings file retains the host
CLI's group-readable access without exposing its contents. Hub, database, and
queue containers are healthy.

`cihub pool doctor` passes the Hub API, pool protocol, compose drift, CLI route,
Tailscale Serve, capability budget, backend DNS, container-to-Ollama bridge,
and peer acceptance checks. The remaining warning is the expected stale
uncapped metadata on core-5 until its host key is reviewed.

## Pool consistency repair

Hub-side context caps were aligned to the already-running Ollama engine values
on beta-1, beta-3-glass, beta-max, beta-ms-a2, beta-nas, beta-red, core-3,
core-4, core-6, and core-17. This did not raise or reload any engine context;
it removed stale or missing Hub metadata. Every touched node returned healthy
responses from Ollama, CI-Hub health, and pool identification after the change.

The current pool still reports core-5 as uncapped because it was intentionally
not administered. The pool also still reports fzzy as unreachable; it was
intentionally not changed.

## Harness audit snapshot

| Harness | Result |
| --- | --- |
| Hermes | Installed and healthy at the runtime level; local oMLX profile present; optional API/browser dependencies remain warnings |
| OpenClaw | Installed; plugin load errors are clear; remote beta-1 gateway is not running/reachable locally |
| Claude | Installed; native doctor and skill validation pass |
| Codex | Installed and authenticated; native doctor reports pre-existing missing rollout files, optional MCP env warnings, and an available update |
| OpenCode | Installed; CI-Common and CI-Engineering MCPs connected; Metricool remains OAuth-pending |
| Aider Desk | Installed with the oMLX profile and CI MCPs recorded |
| Pi GUI | Installed with a portable oMLX model template; native auth store is empty |
| Antigravity | Installed; config inventory is present but native MCP config is empty |
| VS Code | Installed; eight MCP servers recorded and drift scan is clean |

The portable store's `agent-store doctor` completed with 29 healthy checks and
13 warnings. Warnings are credential or optional-service gates, not secrets or
silently copied native state.

## Coding smoke results

The same small `first_unique_char` assignment was sent through the available
noninteractive clients without permitting file edits:

- Hermes: pass through the active `ollama-local` profile backed by oMLX.
- OpenCode: pass after switching its native default from stopped Ollama to
  oMLX; the key is resolved from the process environment, not tracked config.
- Codex: pass through its authenticated remote provider in read-only mode.
- Claude: blocked by an expired OAuth session and could not be refreshed.
- OpenClaw: diagnostic-only; its configured remote beta-1 gateway is not
  running, so no turn was sent.
- Aider Desk, Pi GUI, Antigravity, and VS Code: installed/configured checks
  passed, but these desktop-only surfaces do not expose a safe equivalent
  noninteractive coding command from this machine.

## Follow-up gates

- Review core-5's new SSH host key out-of-band before any change.
- Keep core-7 and fzzy excluded until the operator explicitly reopens them.
- Authenticate Metricool, Companion Hub, Companion Memory, and OmniRoute
  locally when their workflows are needed.
- Re-run the coding smoke matrix from the calling process after each machine
  receives its local credentials and backend endpoint.
