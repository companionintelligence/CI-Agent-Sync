# Portable agent operating context

This is a compact, repository-grounded context pack for moving work between
Claude, Codex, Hermes, OpenClaw, OpenCode, Aider Desk, Pi, and VS Code. It is a
distillation of recurring operating patterns from local Claude/Codex history
and the Companion Intelligence workspace, not a transcript export.

## Workspace model

Companion Intelligence is layered as:

`Capture → Portal/Gateway → Server (memory brain) ← Hub (app runtime) ← Marketplace`

Use the repository map and each repository's `AGENTS.md` as the source of
truth. The main working area is `/Users/liam/devel/ci`; each repository below
it is an independent Git checkout.

For marketing work, preserve this flow:

`CI-Brand-Studio → CI-Common → CI-Engineering → Metricool`

Brand Studio owns the brief and creative direction, CI-Common owns reusable
production helpers and media assembly, CI-Engineering owns evidence and
technical claims, and Metricool owns analytics and approved publishing.

## Operating rules

- Inspect the target repository and its local instructions before changing it.
- Preserve dirty checkouts. Use an isolated worktree for risky, cross-repo, or
  comparison work.
- Refresh the remote base and current PR state before publishing changes.
- Validate the changed surface first, then run the smallest useful regression
  suite. Report baseline failures separately from regressions.
- Keep credentials, OAuth sessions, native app databases, transcripts, and
  private device state in their native stores. Portable files contain policy,
  recipes, and redacted snapshots only.
- Distinguish local, connected-empty, emulator, and live/physical-device
  coverage. A configured endpoint or staged artifact is not proof of runtime
  success.
- For every handoff, record changed files, commands/tests run, artifact or PR
  links, and remaining gates.

## Cross-harness handoff

Give every harness the same short context in this order:

1. Workspace and repository instructions.
2. `integrations/providers/routing.yaml` and
   `integrations/providers/fallbacks.yaml`.
3. The relevant reviewed MCP entry and its authentication/side-effect rules.
4. `workflows/marketing-video.md` for brand, content, or Metricool work.
5. A compact evidence handoff: files, tests, links, and remaining gates.

The selected provider must be visible in the handoff. Preserve tool-calling
capability when falling back. Do not silently move a private task to a remote
provider, and do not fall back after a mutation has started.

## Recurring failure prevention

- Verify the working directory and branch before editing; stale branches and
  similarly named worktrees are a recurring source of false completion.
- Treat MCP transport, authentication, and tool loading as separate checks.
  A registered server is not necessarily connected, authorized, or useful.
- Test a service from the same process/network context that will call it.
  Host reachability does not prove container, gateway, or remote-harness
  reachability.
- Keep loopback gateways bound to loopback and require an access key when they
  expose credentials or provider routes.
- Treat OAuth-required services such as Metricool and Companion Memory as
  pending until the calling harness completes an authenticated smoke test.
- For device-control MCPs, require an explicit target and confirmation before
  any action; a healthy server is not authorization to control a device.

## Done criteria

A harness is ready to use when its native configuration parses, its selected
provider passes an authenticated health/model check, reviewed MCPs connect and
list tools, and one harmless coding or planning task completes. Publishing,
scheduling, account changes, device control, and destructive repository work
remain explicit approval gates.
