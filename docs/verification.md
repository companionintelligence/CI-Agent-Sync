# Specifications and verification

CI Agent Sync carries the reusable half of spec-driven verification: a registry
format that each repository keeps at `.agent-configs/specs.toml`, a policy for
which changes need which evidence, pinned recipes for the toolchains, and the
`agentctl spec` commands that validate a registry and run its checks. Agents in
every harness follow the same short loop, which `agentctl spec block` writes into
a managed section of `AGENTS.md` and `CLAUDE.md`.

| Piece | Where |
| --- | --- |
| Registry contract | `src/spec-registry.ts` (Effect Schema) and the generated `integrations/verification/specs.schema.json` |
| Registry template | `integrations/verification/specs.toml.example` |
| Policy | `integrations/verification/policy.yaml` |
| Toolchains | `integrations/verification/toolchains.yaml` |
| Commands | `agentctl spec toolchains`, `validate`, `list`, `check`, `init`, `block`, `schema` (`src/verification.ts`) |
| Trace replay | `src/itf.ts`, a decoder for Quint's ITF traces |
| Distribution | the opt-in `verification` group in `sync/manifest.yaml` |
| Workflow packs | `spec-first-change`, `doc-claim-audit` and `counterexample-to-regression` in `integrations/workflow-packs.yaml` |

## The registry

A registry lists the formal and executable specifications a repository keeps.
It is TOML so that stdlib-only tools can read it too. A repository with no
entries has a valid, empty registry.

```toml
#:schema https://raw.githubusercontent.com/companionintelligence/CI-Agent-Sync/main/integrations/verification/specs.schema.json
version = 1
repo = "CI-Agent-Sync"

[[spec]]
id = "spec-registry-schema"
title = "Spec registry: the TOML format, its cross-field rules and the generated JSON Schema"
kind = "data-contract"
tool = "effect-schema"
status = "checked"
gate = "required"
artefacts = ["src/spec-registry.ts", "integrations/verification/specs.schema.json"]
covers = ["src/spec-registry.ts", "integrations/verification/**"]
requires = ["node", "effect"]
check = ["npm", "run", "--silent", "spec:schema"]
```

| Field | Rule |
| --- | --- |
| `version` | `1`. Required. |
| `repo` | The GitHub repository name. Required. |
| `[[spec]]` | Zero or more entries. |
| `id` | Kebab case, unique in the repository. Required. |
| `title` | One line. Required. |
| `kind` | `protocol`, `state-machine`, `invariant`, `algorithm`, `data-contract`, `ui-flow`, `component`, `agent-step` or `doc-claims`. Required. |
| `tool` | `quint`, `lemmascript`, `dafny`, `effect-schema`, `storybook`, `bombadil`, `property` or `other`. Required. `other` needs `notes`. |
| `status` | `planned` (a target with no artefact yet), `draft` (an artefact whose check may fail; it never gates), `checked` (the check passes on the default branch) or `conformance` (it passes and the code is tied to it by trace replay, a differential test, or because the verified code is the shipped code). Required. |
| `gate` | `advisory` (the default) or `required`. `required` is allowed only with `checked` or `conformance`. |
| `artefacts` | Repo-relative paths. At least one, and they must exist, unless the entry is `planned`. |
| `covers` | Repo-relative paths or globs (`*`, `**`, `?`) of the code the spec constrains. A plain path also covers everything under it. |
| `docs` | Documents the spec backs: a repo-relative path, or `<Repo>:<path>[#anchor]` for another repository. |
| `requires` | Toolchain ids from `integrations/verification/toolchains.yaml`. |
| `check` | An argv array, run without a shell from the repository root (or `workdir`). Required unless `planned`. Point it at a package script, so that a frozen install provides the pinned tool. |
| `workdir` | Optional. A repo-relative directory to run the check in. |
| `timeout_seconds` | Optional. 1 to 86400; the default is 300. |
| `properties`, `conformance`, `target`, `owner`, `notes` | Optional. `target` is an id from the planning catalogue. |

Paths never start with `/` or a drive letter, never contain a `..` segment, and
use forward slashes. Unknown keys are errors, with a suggestion when a key is
close to a known one (`artifacts` suggests `artefacts`). Artefacts live next to
the code they constrain, or under `spec/<tool>/` at the root.

The decoder reports every problem in one pass, each at its exact path:

```text
spec[1].gate: gate "required" needs status "checked" or "conformance", not "draft"
spec[2].id: duplicate id "ledger": spec[0] already uses it
spec[2].artefacts[0]: "/abs/path" must be relative to the repository root
spec[3].artifacts: unknown key "artifacts" (did you mean "artefacts"?)
```

`integrations/verification/specs.schema.json` is generated from the same schema
(JSON Schema draft 2020-12). The `#:schema` line lets TOML editors such as Taplo
validate as you type, and tools in other languages can use it. The Effect
decoder stays the authority: the JSON Schema cannot express unique ids, so it
accepts a few registries the decoder rejects.

## Commands

```sh
./bin/agentctl spec toolchains                     # probe every pinned toolchain
./bin/agentctl spec validate --repo ../Some-Repo   # decode the registry and check its paths
./bin/agentctl spec list --repo ../Some-Repo
./bin/agentctl spec check --repo ../Some-Repo      # run every non-planned entry's check
./bin/agentctl spec check --repo . --changed-from origin/main
./bin/agentctl spec init --repo ../Some-Repo        # print the template
./bin/agentctl spec init --repo ../Some-Repo --apply
./bin/agentctl spec block --repo ../Some-Repo --check
./bin/agentctl spec block --repo ../Some-Repo --apply
./bin/agentctl spec schema --check
```

| Command | What it does |
| --- | --- |
| `toolchains` | Probes each entry in `toolchains.yaml`, from the repository's `node_modules/.bin` and then `PATH`, reading stdout, stderr or both (`java -version` writes to stderr), with a 5-second timeout (`--timeout` changes it). A tool is ok at its pinned version, a warning at another version, and not installed when no candidate is found. `--only` limits the probes. |
| `validate` | Decodes `.agent-configs/specs.toml` under `--repo` (default: the current directory) and checks that artefacts and workdirs exist inside the repository, that `requires` names known toolchains, and that each `covers` pattern matches a tracked file (a warning otherwise). |
| `list` | Lists the entries with their tool, status, gate and check. |
| `check` | Runs each selected entry's `check`. `--only IDS`, `--tool NAMES` and `--changed-from REF` select entries; `--changed-from` picks the entries whose `covers` or `artefacts` match `git diff --name-only REF...HEAD`. |
| `init` | Prints the template with `repo` filled in. With `--apply` it writes `.agent-configs/specs.toml`, and only when that file does not exist. |
| `block` | Renders the managed section from the registry: the agent loop, a table of the entries that run (id, tool, status, gate), the planned entries, and a pointer to this repository's `integrations/verification/` and `skills/`. It prints the section by default; `--check` exits non-zero when a file is out of date, and `--apply` writes. |
| `schema` | Prints the JSON Schema generated from `src/spec-registry.ts`. `--write` regenerates the committed file and `--check` fails when it differs. |

Every command takes `--json` and prints the standard envelope,
`{schema_version, summary, checks}`, where each check has an `id`, a `status`
(`ok`, `warn`, `error`, `info`, `skipped` or `not-installed`) and a `detail`.
`check` adds the entry, its gate, the command, the duration and the exit code,
plus a `selection` object. The exit code is 1 when any check is an error, and 2
for a usage error.

The managed section sits between `<!-- agent-sync:specs:begin -->` and
`<!-- agent-sync:specs:end -->`. `block --apply` updates both `AGENTS.md` and
`CLAUDE.md` when they exist, creates `AGENTS.md` when neither does, appends the
section when a file has no markers, and changes nothing outside them.

## Gates

| Status | Runs | A failure is |
| --- | --- | --- |
| `planned` | Never | Reported as skipped, never as ok |
| `draft` | Yes | A warning |
| `checked`, `conformance` with `gate = "advisory"` | Yes | A warning |
| `checked`, `conformance` with `gate = "required"` | Yes | An error, which fails the command |

- A check that cannot find a required toolchain does not run. That is an error
  for a required entry and a warning for an advisory one.
- A skipped check is not a pass. `check` never reports a planned, filtered or
  unrun entry as ok.
- A timeout, an output over 8 MB, or a program that cannot start counts as a
  failure.
- Pre-push checks stay within about two minutes: typecheck and a bounded
  simulation for Quint, proofs on changed files for LemmaScript and Dafny, the
  stories a change touches. Apalache verification, full story runs and Bombadil
  exploration belong on a dispatch-only workflow or a nightly local run.
- An entry moves from advisory to required after two weeks green on the
  default branch, with the owner's review.

## The policy

`integrations/verification/policy.yaml` holds the rules every harness follows.

| Change class | Tools | Evidence |
| --- | --- | --- |
| Protocol or state machine | `quint` | A model with named invariants and one observation (a reachability witness) per invariant; `quint typecheck`, `quint test` and a bounded `quint run` |
| Pure decision core | `lemmascript`, `dafny` | Contracts with `unread-annotations` set to `error` and a nonzero verification-condition count, or a Dafny reference model |
| Data contract or agent step | `effect-schema`, `property` | A schema with path-exact errors, a generated JSON Schema with a drift check, and round-trip property tests |
| UI component | `storybook` | A story per state, a play function per interaction, axe at `error` |
| UI flow | `bombadil` | A property suite against a stubbed API, with virtual time and a bounded witness |
| Doc claim | none | The claim cites a spec id, a claim id or a test |

It also sets the evidence rules (a skipped check is not a pass; every run
records its seed, bound or depth; a counterexample becomes a regression test
before the fix), the escape hatches an agent's change never adds without the
owner's review (`assume`, axioms, `havoc`, `{:verify false}`, a deleted
invariant, a lowered bound, a gate downgrade), the confidentiality rule, and the
cost rule: no new automatic CI trigger without an owner decision, and local
checks first. `agentctl validate` fails if the policy names a tool, kind, gate
or status that the registry and the toolchains do not know.

## Toolchains

| Id | Ring | Version | Checks |
| --- | --- | --- | --- |
| `node` | adopt | 22.6.0 or later | runtime |
| `java` | trial | 21 or later | runtime for `quint verify` |
| `chromium` | trial | any | runtime for Bombadil |
| `quint` | trial | 0.34.0 (Apalache 0.62.4) | `quint` |
| `effect` | trial | 4.1.6 | `effect-schema`, `property` |
| `lemmascript` | trial | 0.6.14 | `lemmascript` |
| `dafny` | trial | 4.11.0 | `dafny` |
| `storybook` | trial | 10.6.9 | `storybook` |
| `bombadil` | trial | 0.8.0 | `bombadil` |
| `vibelang` | hold | not installed | nothing |

Each entry in `toolchains.yaml` gives the install channels with the npm
integrity or the sha256 of each release asset, the probe, the environment
(`QUINT_HOME`, `STORYBOOK_DISABLE_TELEMETRY=1`), prerequisites, the licence, the
upstream AI docs and skills, and the traps found when the tool was tried. Three
to know first:

- Concurrent `quint verify` runs share Apalache's server on port 8822 and break
  each other. Give every run its own `--server-endpoint=localhost:<port>`.
- Quint downloads its evaluator and the Apalache archive on first use without
  checking a checksum. Pre-seed `QUINT_HOME` from the checksummed archives.
- LemmaScript passes a misspelled annotation silently unless `lemmascript.json`
  sets `unread-annotations` to `error`.

## Replaying Quint traces

`src/itf.ts` decodes the ITF traces that `quint run --mbt --out-itf` writes, so a
TypeScript test can drive the implementation through the same steps:

```ts
import { readFileSync } from "node:fs";
import { itfAction, itfPicks, parseItfTrace } from "./itf.ts";

const trace = parseItfTrace(readFileSync("traces/run-0.itf.json", "utf8"));
for (const state of trace.states.slice(1)) {
  const action = itfAction(state); // mbt::actionTaken
  const picks = itfPicks(state);   // mbt::nondetPicks, with Some(x) as x and None as undefined
  // apply `action` with `picks` to the implementation, then compare it with `state`
}
```

`#bigint` decodes to `bigint`, `#set` to `Set`, `#map` to `Map` and `#tup` to an
array; `#unserializable` is an error. Generated traces are gitignored; keep a
hand-written fixture under `src/fixtures/` when a test needs one.

## Opting a repository in

1. Start a registry: `./bin/agentctl spec init --repo ../Some-Repo --apply`, then
   replace the example entry. A repository with nothing checked yet lists
   `planned` entries, so the next agent knows what to model first.
2. Validate it: `./bin/agentctl spec validate --repo ../Some-Repo`.
3. Add the managed section: `./bin/agentctl spec block --repo ../Some-Repo --apply`.
   Run `--check` in a gate to catch drift.
4. Optionally receive the policy, the toolchains, the JSON Schema and the
   template: add `verification` to `groups` in the target's
   `.agent-configs/sync.yml`, then run `./bin/agentctl sync` and review the plan
   before `--apply`. The files land in `.agent-configs/verification/`. The sync
   never writes the target's own `.agent-configs/specs.toml`.
5. Install the skills: `npx skills add companionintelligence/CI-Agent-Sync`.

This repository keeps its own registry in `.agent-configs/specs.toml`.

## Safety boundary

- Nothing is written without `--apply` or `--write`. `init` never overwrites a
  registry, and `block` changes only the text between its markers.
- Writes stay inside the repository: a path that leaves it through `..` or a
  symlink is refused.
- Checks run without a shell, in their own process group, with the entry's
  timeout and an output cap. The detail keeps only a redacted tail of the
  output, and reports show the home directory as `~`, so a report pasted into
  a pull request does not carry a local user name.
- Probes have a short timeout, and the git reads behind `--changed-from` and the
  `covers` check run with `GIT_OPTIONAL_LOCKS=0`, so they never contend with
  other agents' checkouts.
- Models, proofs, tests and counterexamples that describe an unfixed security
  defect stay private until the fix is published. Fixtures are synthetic.
