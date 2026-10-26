# ADR-0001: Default skills are pinned, hashed and plan-first

Status: accepted

## Context
Every harness should carry a small baseline of skills, but skill text is
guidance that can embed commands or exfiltration. Native skill folders are also
user state that this repository must not overwrite.

## Decision
- `integrations/skills.yaml` declares `default_skills` with a full commit SHA
  and a sha256 of the reviewed `SKILL.md`.
- `agentctl validate` fails when a harness has no install path or exemption.
- `agentctl skills plan` is read-only. `agentctl skills apply` is a dry run
  unless `--confirm` is given; it writes only the declared target, never
  overwrites an existing file, and refuses a download whose hash differs.
- Harnesses without a safe direct target keep a documented manual step.

## Consequences
Bumping a skill is a reviewed change to the pin and hash. Skills requiring
installers or scripts are out of scope for `apply`.
