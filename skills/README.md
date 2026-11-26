# First-party skills

Agent skills for spec-first work: specify a rule, check it with a pinned toolchain, tie the code to
it, and cite it in docs. Each folder holds one `SKILL.md` with `name` and `description` frontmatter,
in the open Agent Skills format that Claude Code, Codex, OpenCode, Copilot and the other harnesses
read. They are registered in [integrations/skills.yaml](../integrations/skills.yaml) under
`first_party_skills`.

| Skill | Load it when | Tool and pin |
|---|---|---|
| [spec-first](spec-first/SKILL.md) | Changing covered behaviour; adding any spec; writing a PR that says something is checked | The registry (`.agent-configs/specs.toml`) and `agentctl spec` |
| [quint-spec](quint-spec/SKILL.md) | Protocols, lifecycles, retries, leases, races | Quint 0.34.0 with Apalache 0.62.4 |
| [lemmascript-proof](lemmascript-proof/SKILL.md) | Proving a small pure TypeScript decision function in place | LemmaScript 0.6.14 with Dafny 4.11.0 |
| [dafny-reference-model](dafny-reference-model/SKILL.md) | A proved reference model or a test-only oracle; auditing `.dfy` files | Dafny 4.11.0 release zip, sha256-checked |
| [effect-schema-contract](effect-schema-contract/SKILL.md) | Data contracts at boundaries, JSON Schema export, property tests | effect 4.1.6 |
| [storybook-contract](storybook-contract/SKILL.md) | Component states, play functions, accessibility | Storybook 10.6.9 with the Vitest addon |
| [bombadil-property](bombadil-property/SKILL.md) | What a web UI may and must do over time | Bombadil 0.8.0 |
| [doc-claim-binding](doc-claim-binding/SKILL.md) | Writing docs or PR text that states a product fact | Spec ids, claim ids and tests |

Start with `spec-first`; it routes to the others by the kind of rule.

## Install

Installs stay explicit and audit-first, like the default skills. Read the `SKILL.md` you install.
Pin the source to the CI-Agent-Sync commit you reviewed (the skills CLI accepts a full commit after
`@`), or install from a reviewed checkout:

```sh
COMMIT=0000000000000000000000000000000000000000   # replace with the full SHA you reviewed
DISABLE_TELEMETRY=1 npx skills add "companionintelligence/CI-Agent-Sync@$COMMIT" --skill spec-first --global --agent claude-code
DISABLE_TELEMETRY=1 npx skills add "companionintelligence/CI-Agent-Sync@$COMMIT" --skill '*' --global --agent codex
DISABLE_TELEMETRY=1 npx skills add . --skill quint-spec --global --agent claude-code   # from the checkout root
```

The skills CLI needs Node 22.20 or newer; `DISABLE_TELEMETRY=1` turns off its usage reporting.
`npx skills add . --list` shows the eight skills without installing anything. For harnesses the
skills CLI does not cover, copy `skills/<id>/SKILL.md` into that harness's skills folder; the
per-harness commands are in `integrations/skills.yaml`.

## Rules for these files

- Every command, flag and API in a skill was run against the pinned version or taken from the tool's
  own documentation. When a pin moves, rerun the examples and update the skill in the same change.
- Keep each `SKILL.md` under 250 lines. Put the version in the text wherever behaviour depends on it.
- Examples are synthetic and generic. Never put a model, proof, test or counterexample that describes
  an unfixed security defect into this public repository.
- Upstream skills are referenced at pinned commits, not copied (see `upstream_skill_references` in
  `integrations/skills.yaml`). LemmaScript's and the storybookjs skills repositories carry no licence:
  link to them only.
