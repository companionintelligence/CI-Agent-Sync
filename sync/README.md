# Repository config sync

This directory is the store's distribution contract, inspired by the useful
parts of [AI Harness](https://github.com/themoment-team/themoment-ai-harness-sync):

- a versioned manifest instead of implicit file copying;
- per-target enablement and group selection;
- include/exclude overrides for exceptions;
- explicit deletion records for renames and removals;
- plan-first, observable updates that skip dirty or detached repositories.

The implementation is intentionally local and provider-neutral. It does not
install a GitHub App, transmit credentials, or copy native agent state. A
future GitHub workflow can consume this same manifest and open PRs, but local
application remains safe and useful without remote credentials.

## Setup

```sh
cp sync/targets.yaml.example sync/targets.yaml
# edit machine-local paths and targets
./bin/agent-store sync
./bin/agent-store sync --apply
```

The default is a plan. `--apply` copies only manifest-listed files. Existing
dirty or detached Git checkouts are skipped. A target may add
`.agent-configs/sync.yml` to disable sync, select groups, or override items.

## Target policy

```yaml
enabled: true
groups: [shared]
exclude:
  - shared/plugins-registry
include: []
overrides: {}
```

The target policy controls distribution only; it does not change the target's
native Claude, Codex, Hermes, OpenClaw, VS Code, or other client state.

## Versioning and deletion

Breaking changes should receive a new `version`, while the prior source is
archived before the manifest is updated. Renames and removals belong in the
manifest's `deletions` list. Deletion is never automatic: use `--prune` only
after reviewing the plan.
