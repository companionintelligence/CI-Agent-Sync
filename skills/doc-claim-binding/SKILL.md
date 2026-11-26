---
name: doc-claim-binding
description: >-
  Load before writing or editing docs, a README, an ADR, release notes, an llms.txt or a PR
  description that states a product fact (a count, a default, a flag, a port, an environment
  variable, a limit, availability or a guarantee), and before pushing a docs change. Covers never
  typing a product fact by hand, citing a spec id, claim id or test, and checking claims before a
  docs push.
---

# Doc-claim binding

Most wrong docs were right once: the product moved and the sentence did not. The rule is simple. A
document states a checkable product fact only by pointing at the thing that checks it, and an agent
never types such a fact from memory.

## What counts as a claim

- Values: defaults, flag names and their default state, ports, environment variable names, limits,
  versions, "latest".
- Counts: tools, intents, endpoints, supported clients or platforms.
- Behaviour: "X never happens", "Y needs Z", "fails closed", which sign-in flows work, what data
  leaves the device.
- Availability: stores, platforms, "not yet released", "in preview".
- Assurance: "verified", "proved", "model-checked", "tested".

Plans, opinions and how-to steps are not claims, but a how-to step that names a flag or a command
contains one.

## Rules

1. Do not type a product fact by hand. Generate it from the artefact that defines it (a JSON Schema
   export, a manifest, a contract file, a registry entry, `lsc info` output), or, where the docs have
   a claims registry, write the claim id and let the build render the value from pinned evidence.
   If no claim exists, add one (id, source artefact, pointer) instead of typing the value.
2. Cite evidence for every behaviour claim: a spec id from `.agent-configs/specs.toml` and the
   property name, a claim id, or a test file and test name. Across repositories write
   `<Repo>:<spec-id>`.
3. Back-link: add the document to the registry entry's `docs` field, as a repo path or
   `<Repo>:<path>[#anchor]`, so a change to the spec shows which docs to reread.
4. Only an entry at `checked` or `conformance` backs a statement of fact. A `planned` or `draft`
   entry backs "planned" or "in progress", never "guaranteed".
5. Say what the evidence covers. A Quint property holds in the model up to its bound; a LemmaScript
   proof assumes integer numbers and Unicode strings; a Bombadil run found no violation in the time
   it ran; a story checks the states it lists. Do not upgrade "tested" to "guaranteed".
6. Every identifier you name (environment variable, flag, route, file, command, symbol) must exist in
   the product at the version the page is about. State that version.
7. Do not describe an unfixed security defect in public docs. Correct the page to the safe
   statement, and report the defect privately.

## Cite it

```markdown
A job is sent at most three times, then dropped
(spec `retry-queue`, property `triesBounded`: model-checked to 10 steps in
[spec/quint/retryQueue.qnt](../spec/quint/retryQueue.qnt)).

Settings files reject unknown keys (spec `settings-contract`; the published schema is
[schemas/settings.schema.json](../schemas/settings.schema.json), generated from the decoder).
```

And in the registry entry:

```toml
docs = ["docs/queue.md", "docs/settings.md"]
```

## Check before you push docs

```sh
agentctl spec list                     # each cited spec id exists; note its status
agentctl spec check                    # the cited entries pass on this commit
git grep -n 'triesBounded' -- spec/    # each cited property is in the artefact
git show v1.4.0:config/default.json | grep -n 'retryLimit'   # each named identifier exists at the release
```

Then run the docs build with its claims check where the repository has one, and regenerate any page
section that is generated from an artefact (`git diff --exit-code` must be clean afterwards).

A claims checker is meant to fail on an unknown claim id, missing or stale evidence, a hand-typed
duplicate of a registered fact, and an identifier that does not exist at the pinned ref. If yours
does not yet catch one of these, check that case by hand and say so in the PR.

## Finding hand-typed facts

Search the change before you push, then cite or generate every hit:

```sh
git diff --cached -U0 | grep -nE '^\+.*\b[0-9]+ (tools|intents|endpoints|clients|stories)\b'
git diff --cached -U0 | grep -nE '^\+.*\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b'      # environment variable names
git diff --cached -U0 | grep -nE '^\+.*(latest|default(s)? to|port [0-9]+|fails closed|never)'
```

## When the docs and the product disagree

The spec, the test or the release artefact decides, not memory and not an older page. If the evidence
contradicts the code, the code has a defect: open it against the product and leave the doc at what
the evidence shows. If the evidence itself is missing, add a `planned` registry entry and phrase the
doc as unverified.

## PR verification block

```markdown
### Claims

| Page | Claim | Evidence | Checked at | Result |
|---|---|---|---|---|
| docs/queue.md | at most three sends | `retry-queue` / `triesBounded` | abc1234 | `agentctl spec check` pass |
| docs/settings.md | unknown keys rejected | `settings-contract` | abc1234 | schema regenerated, no diff |
```

## References

- Registry, status ladder and loop: `spec-first`. Generating values from contracts:
  `effect-schema-contract`. Contracts from proofs: `lemmascript-proof` (`lsc info`).
