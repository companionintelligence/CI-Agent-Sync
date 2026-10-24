# AI Harness sync concept review

Reviewed [themoment-team/themoment-ai-harness-sync](https://github.com/themoment-team/themoment-ai-harness-sync)
and its Marketplace listing on 2026-10-24.

## Adopted

- A versioned distribution manifest instead of implicit recursive copying.
- Named groups with per-target `enabled`, `groups`, `include`, and `exclude`
  controls.
- Explicit item IDs and versions so future breaking changes can be archived
  and pinned deliberately.
- An explicit deletion list for renames and removals; pruning is opt-in.
- Plan-first execution with machine-readable output.
- Dirty and detached Git checkouts are skipped to preserve active work.
- A target-side policy file that travels with the target repository, while
  machine-specific target paths remain local and ignored.

## Deliberately deferred

- GitHub App installation-token discovery and automatic cross-organization PRs.
  Those are useful later, but require an explicit GitHub App, repository
  permissions, and secret-management decision. The local manifest is now a
  stable contract that a future PR workflow can consume.
- A dashboard and external notifications. The sync command already emits
  human-readable and JSON results; a dashboard can be added without changing
  the manifest format.

## Deliberately not copied

- Native Claude, Codex, Hermes, OpenClaw, VS Code, or other app state.
- OAuth sessions, API keys, cookies, private keys, auth databases, or `.env`
  files.
- Third-party GitHub Actions or unpinned runtime installs.

## Result

The store now exposes `./bin/agent-store sync`. It is a dry-run by default,
copies only entries in `sync/manifest.yaml`, supports per-target policy, and
requires `--prune --apply` for explicit deletions. `scripts/verify.sh` validates
the manifest and runs a disposable clean/dirty target smoke test.
