# Marketing video workflow

This is the provider- and harness-neutral workflow for Companion Intelligence
marketing work. It keeps planning, production, publishing, and learning in one
repeatable loop while leaving credentials and native client state on the
machine.

## Local surfaces

Set these variables in a machine-local shell profile or overlay. Do not commit
absolute paths or credentials.

```sh
export CI_ROOT="${CI_ROOT:-$HOME/devel/ci}"
export CI_COMMON_ROOT="${CI_COMMON_ROOT:-$CI_ROOT/CI-Common}"
export CI_ENGINEERING_ROOT="${CI_ENGINEERING_ROOT:-$CI_ROOT/CI-Engineering}"
export CI_BRAND_STUDIO_ROOT="${CI_BRAND_STUDIO_ROOT:-$CI_ROOT/CI-Brand-Studio}"
export CI_BRAND_STUDIO_URL="${CI_BRAND_STUDIO_URL:-http://127.0.0.1:3858}"
export CI_VIDEO_OUT="${CI_VIDEO_OUT:-$HOME/Movies/CI-Product-Videos}"
```

The checkout layout may differ. On the current machine,
`CI_ENGINEERING_ROOT` is `/Users/liam/devel/ci/0-HUB/CI-Engineering`; use the
machine overlay rather than encoding that path in shared config.

- **CI-Brand-Studio** is the planning and approval surface: brand context,
  topics, briefs, social packs, research, and the Metricool export.
- **CI-Common** is the shared dashboard and run store for campaigns, social
  assets, and product-video generation. Its MCP server is
  `apps/dashboard/mcp.mjs --start`.
- **CI-Engineering** is the evidence and engineering surface for product-film
  state, fleet QA, and the product-video CLI. Its MCP server is
  `tools/mcp-server.mjs --start`.
- **Metricool** is the remote analytics and scheduling surface at
  `https://ai.metricool.com/mcp`. Follow the [official Metricool MCP connection
  guide](https://help.metricool.com/how-to-connect-metricools-mcp-eqp9h) and use
  URL-based OAuth where the client supports it. It must be authenticated in the
  client before analytics or scheduling is useful.

## Standard loop

1. Start Brand Studio with the repository's Node and pnpm versions, then use
   its plan/brief/review flow to establish the approved campaign and copy.
2. Read CI-Common `dashboard_status`, then inspect the relevant video and
   social state. Use `video_status`, `video_runs`, and `video_run_log` for
   evidence; use `video_variants` and `video_variant_get` for short-form cuts.
3. Read CI-Engineering `video_products`, `video_state`, and `video_actions`.
   Treat its checkout, ref, shot coverage, and measurement output as the
   source of truth for whether a film is ready.
4. Run only the smallest next action that the state permits. Mutating tools
   require `confirm: true`; capture and revoice also need explicit owner
   approval because they alter shared or committed material.
5. Review the generated assets in the dashboard and record the owner approval
   before scheduling or publishing. Never infer approval from a passing QA
   result.
6. Use Metricool for the scheduled plan and realized metrics. Feed the useful
   results back into Brand Studio's insights/research loop instead of treating
   a scheduled post as a completed campaign. Metricool's connection grants
   broad access to connected brands, metrics, posts, inboxes, and related
   account surfaces, so authorize only trusted clients and revoke access from
   the client when it is no longer needed.

## CLI fallback

The same workflow is available without MCP:

```sh
cd "$CI_COMMON_ROOT"
node tools/ci-video-ctl.mjs status
node tools/make-videos.mjs --list

cd "$CI_ENGINEERING_ROOT"
node tools/ci-video-ctl.mjs status
```

Use `apps/dashboard/mcp.mjs --start` and
`tools/mcp-server.mjs --start` as stdio MCP servers for Claude, Codex,
OpenCode, and VS Code. Hermes and OpenClaw use the workflow as an opt-in
recipe: Hermes stays lean for local models, and the current OpenClaw desktop
does not expose a native MCP registration command.

## Safety and portability rules

- Keep local servers on loopback. Do not expose the dashboard or video
  generator to a LAN or tailnet without an explicit authenticated gateway.
- Do not place API keys, OAuth sessions, Metricool tokens, or provider secrets
  in this workflow or in repository snapshots.
- Use `plan` before `apply` when distributing this file to a repository.
- Skip dirty or detached checkouts. Preserve user changes and report the gate.
- A healthy MCP handshake proves transport only. It does not prove that the
  product checkouts, source refs, renders, credentials, or publishing account
  are ready.
- Keep full renders, capture, revoice, scheduling, and publishing approval
  gated. Start with read-only status and a single selected product.
