---
name: spec-first
description: >-
  Load before changing behaviour in a repository that has .agent-configs/specs.toml, before adding a
  model, proof, schema, story or UI property, and before writing docs or a PR that says a behaviour
  is checked. Covers the spec registry, the status ladder, choosing a tool for a rule, the six-step
  agent loop, the agentctl spec commands, evidence rules and the PR verification block.
---

# Spec first

Work from the specification. Read it before you change covered code, change it first when a rule
changes, run its check, and report exactly what ran. This is the umbrella skill. Each tool has its
own skill, listed at the end.

## When to use

- Your change touches a path that a registry entry lists in `covers`.
- You are adding a rule that a model, proof, schema, story or property can state.
- You are writing docs or a PR description that says a behaviour holds.

Not for formatting, comment-only edits or dependency bumps that change no behaviour. If you change
behaviour that no entry covers, add a `planned` entry so the next agent knows what to specify.

## The registry

Each repository owns `.agent-configs/specs.toml`. Sync never overwrites it. The JSON Schema is
`integrations/verification/specs.schema.json` in CI-Agent-Sync, and `specs.toml.example` next to it
is the template.

```toml
#:schema https://raw.githubusercontent.com/companionintelligence/CI-Agent-Sync/main/integrations/verification/specs.schema.json
version = 1
repo = "example-repo"

[[spec]]
id = "retry-queue"
title = "Retry queue: send, acknowledge, refuse and drop after the last try"
kind = "state-machine"
tool = "quint"
status = "checked"
gate = "advisory"
artefacts = ["spec/quint/retryQueue.qnt", "spec/quint/retryQueueTest.qnt"]
covers = ["src/queue/**"]
docs = ["docs/queue.md"]
requires = ["node", "quint"]
check = ["npm", "run", "--silent", "spec:retry-queue"]
properties = ["triesBounded", "droppedOnlyAfterLastTry"]
notes = "Three jobs, three tries. Bounded simulation in pre-push; Apalache by dispatch."
```

| Field | Rule |
|---|---|
| `version`, `repo` | Required. `version = 1`; `repo` is the GitHub repository name. |
| `id`, `title` | Required. Kebab-case id, unique in the repo. One-line title. |
| `kind` | `protocol`, `state-machine`, `invariant`, `algorithm`, `data-contract`, `ui-flow`, `component`, `agent-step` or `doc-claims`. |
| `tool` | `quint`, `lemmascript`, `dafny`, `effect-schema`, `storybook`, `bombadil`, `property` or `other`. `other` needs `notes`. |
| `status` | `planned`, `draft`, `checked` or `conformance` (the ladder below). |
| `gate` | `advisory` (default) or `required`. `required` only with `checked` or `conformance`. |
| `artefacts` | Repo-relative paths. They must exist unless the entry is `planned`. |
| `covers` | Paths or globs of the code the spec constrains. Agents and the pre-push gate use it to pick the specs a change touches. |
| `docs` | Documents the spec backs: a repo path, or `<Repo>:<path>[#anchor]`. |
| `requires` | Toolchain ids from `integrations/verification/toolchains.yaml`. |
| `check` | An argv array run without a shell from the repo root (or `workdir`). Required unless `planned`. Point it at a package script so a frozen install supplies the pinned tool. |
| `timeout_seconds` | Optional. Default 300. |
| `properties`, `conformance`, `target`, `owner`, `notes` | Optional. Put model assumptions (bounds, integer model, stubs) in `notes`. |

Artefacts live next to the code they constrain or under `spec/<tool>/`. LemmaScript contracts stay in
the `.ts` file. Stories stay beside their components.

## The status ladder

1. `planned`: a target with no artefact yet. Never runs, never gates.
2. `draft`: an artefact whose check may fail. Never gates.
3. `checked`: the check passes on the default branch.
4. `conformance`: the check passes and the code is tied to the spec by trace replay, a differential
   test, or because the verified code is the shipped code. Say which in `conformance`.

Moving up needs the evidence in the PR. Moving down, or `required` to `advisory`, needs the owner.

## Choose the tool by the kind of rule

| The rule is about | Tool | Skill |
|---|---|---|
| State over time: protocols, lifecycles, retries, leases, queues, races | Quint | `quint-spec` |
| A small pure TypeScript decision: policy, containment, redirect or scope checks | LemmaScript | `lemmascript-proof` |
| A pure rule in non-TypeScript code, or an oracle for a differential test | Dafny | `dafny-reference-model` |
| The shape of data crossing a boundary: wire formats, config, manifests | Effect Schema | `effect-schema-contract` |
| Properties over generated data from a schema | `effect/Arbitrary` (`tool = "property"`) | `effect-schema-contract` |
| How one component renders and responds, accessibility included | Storybook | `storybook-contract` |
| What a web UI may and must do over time | Bombadil | `bombadil-property` |
| A product fact stated in docs | Claim binding | `doc-claim-binding` |

Write each rule once and link the other layers to it. Do not try to verify through I/O, regex or
async code: pull out a pure core first. A proof is about a model, so pair it with a test against the
real code.

## The loop

1. Before changing behaviour that an entry `covers`, read the entry and its artefacts.
2. If the change alters a rule, change the spec first and make its check pass. A counterexample
   becomes a regression test before the fix.
3. Run `agentctl spec check` (or the entry's `check`) before pushing. A skipped check is not a pass,
   and a check that cannot find its toolchain fails.
4. A doc claim about behaviour cites a spec id, a claim id or a test. Do not type product facts by
   hand.
5. Do not weaken a spec without the owner's review: no `assume`, axiom, `havoc`, `{:verify false}`,
   deleted invariant, lowered bound or `gate` downgrade in an agent's change. That covers each
   tool's own hatches too: LemmaScript `autohavoc`, `extern` and type overrides, Dafny
   `decreases *`, a deleted Quint `observation`, a lower Storybook `a11y.test`, a removed Bombadil
   witness.
6. Put a verification block in the PR body: which entries ran, on which commit, with which seed,
   bound or depth.

## Commands

| Command | What it does |
|---|---|
| `agentctl spec toolchains` | Probes the pinned toolchains this machine has. |
| `agentctl spec validate` | Validates `.agent-configs/specs.toml` against the schema and its rules. |
| `agentctl spec list` | Lists the entries, their status and what they cover. |
| `agentctl spec check` | Runs each entry's `check` in a bounded child process. |
| `agentctl spec init` | Writes a registry template. Writes only with `--apply`. |
| `agentctl spec block` | Writes the managed agent-loop block into AGENTS.md and CLAUDE.md. Writes only with `--apply`. |
| `agentctl spec schema` | Prints the registry JSON Schema. |

Reports use the standard `{schema_version, summary, checks}` envelope. Flags are in
`docs/verification.md`. Where `agentctl` is not installed, run each entry's `check` argv from the
repository root and read its exit code and output yourself.

## Evidence rules

- Exit 0 alone is not evidence. Several tools exit 0 having checked nothing. Require the tool's result
  line, a nonzero count of what was checked (traces, verification conditions, stories, states), and a
  planted-bug variant that must fail.
- Give every important property a witness for its antecedent: a Quint `observation`, a Bombadil
  reachability property, a story that reaches the state. A property whose antecedent never happens
  passes vacuously.
- Pass bounds explicitly: sample counts, steps, depth, time limits, generator size. Record them.
- Pin exact versions and verify downloads by checksum. A lockfile is part of the pin.
- Keep heavy checks (model checking, long exploration) out of pre-push; run them by dispatch or on a
  schedule. Pre-push spec checks stay under about two minutes.

## Confidentiality

A model, proof, test, counterexample, comment or commit message that describes an unfixed security
defect never goes into a public repository. Stop, keep the work local, and report it privately.
Fixtures are synthetic: never read a personal corpus into a spec or test.

## PR verification block

```markdown
### Verification

| Entry | Tool | Command | Commit | Bounds | Result |
|---|---|---|---|---|---|
| retry-queue | quint 0.34.0 | `npm run spec:retry-queue` | abc1234 | 10000 samples, 20 steps | pass; planted bug fails |

Not run: <entry id> (<reason>).
```

## Tool skills

`quint-spec`, `lemmascript-proof`, `dafny-reference-model`, `effect-schema-contract`,
`storybook-contract`, `bombadil-property`, `doc-claim-binding`. The index is `skills/README.md`.
