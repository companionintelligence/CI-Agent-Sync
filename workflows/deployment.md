# Portable deployment workflow

The same deployment contract is available from Hermes, OpenClaw, Claude,
Codex, OpenCode, Aider Desk, Pi, Antigravity, and VS Code. ChatGPT can help
prepare or review a deployment, but its desktop app does not inherit this
repository's process-local credential injection; run the approved command in a
local harness or terminal.

## Cloudflare

1. Identify the repository and the exact Wrangler target (Worker, Pages
   project, D1 database, or other resource).
2. Inspect the working tree and repository instructions.
3. Run `wrangler whoami` and confirm the intended account.
4. Run the target-specific dry run or preview.
5. State the deployment scope, public impact, and rollback path.
6. Obtain confirmation immediately before `wrangler deploy` or another write.
7. Re-run the target health check and record the deployment id or URL.

The portable credential is `agent-configs-cloudflare` in 1Password and is
injected only into the command process:

```sh
./bin/agent-store with cloudflare -- wrangler whoami
```

The current laptop's native Wrangler OAuth is useful for interactive work but
is not copied to other machines. Prefer a target-scoped API token for CI or
transplanted automation.

## Companion Hub catalog or fleet

For a catalog submission, use `cihub submit --dry-run APP_DIRECTORY` first and
keep the pending template and image changes visible. A real `cihub submit`
pushes/ingests a catalog release and is approval-gated.

For fleet updates, use the read-only sequence below and keep the current
operator exclusions intact:

```sh
./bin/agentctl fleet smoke --json --strict
cihub fleet list --json
cihub fleet preflight --json
cihub pool doctor
```

Only after naming the target nodes, release/version, blast radius, and rollback
plan should an operator approve:

```sh
cihub fleet update --hub --execute
```

Re-run fleet smoke, `cihub fleet status --json`, and `cihub pool status` after
the change. Anonymous HTTP health proves reachability only; each Hub target
still needs its own scoped MCP, QA, or inference credential when authenticated
operations are required.

## Credential and rollback rules

- Never commit Wrangler tokens, Hub keys, OAuth databases, or `.env` files.
- Keep Cloudflare credentials separate from Hub MCP, QA, and inference keys.
- Do not use a full/admin key for a read-only preflight.
- Never retry a deployment after a mutation has partially succeeded without
  checking the target's actual state.
- Preserve dirty checkouts and use isolated worktrees for release preparation.
