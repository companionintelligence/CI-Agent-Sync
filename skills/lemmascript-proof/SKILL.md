---
name: lemmascript-proof
description: >-
  Load when proving a small pure TypeScript decision function in place (policy and grant checks,
  path containment, redirect or scope validation, ranking, redaction), or when a registry entry has
  tool = "lemmascript". Covers //@ contracts, lsc check over LemmaScript-files.txt, lemmascript.json
  with unread-annotations set to error, the number and string model caveats, and the gates CI must
  own because the tool's own additions-only check can be bypassed.
---

# LemmaScript proofs

LemmaScript proves contracts written as `//@` comments in ordinary TypeScript. `lsc` translates the
function to Dafny and Dafny proves it. The annotated `.ts` file stays the production code: the
comments are invisible to `tsc` and bundlers, so nothing changes at runtime. It is a tech preview
(0.6.x, fast releases, one main maintainer): pin exactly and pair every proof with a test.

## When to use

Use it for small pure decision cores: consent and grant policy, path containment, redirect
validation, scope checks, ranking, redaction.

Do not use it for regex, `await`, I/O, network, randomness, DOM, `any`, inheritance or float-heavy
maths. Pull a pure core out of such code and prove the core. In-place annotation of a helper that
uses a regex and `node:path` failed in the trials; the extracted pure core verified in 2 seconds.
For a rule with steps over time use `quint-spec`; for code that is not TypeScript use
`dafny-reference-model`.

## Install (pinned)

```sh
npm install --save-dev --save-exact lemmascript@0.6.14
```

The install is about 111 MB, mostly LLM SDKs that `lemmascript` pulls in through caret ranges, so
only the committed lockfile pins them. `lsc` calls `dafny` from `PATH`. Use the Dafny 4.11.0 release
zip, and unpack it only when its sha256 matches (other platforms' zips and digests are in
`dafny-reference-model`):

```sh
DL="$(mktemp -d)"; ZIP=dafny-4.11.0-arm64-macos-13.zip   # keep downloads out of the repo
gh release download v4.11.0 -R dafny-lang/dafny -p "$ZIP" --dir "$DL" &&
  echo "c90c75e7d5db9c6ccbb7127840dfe43f0ac938b039a7ebed146d8ead383a572f  $DL/$ZIP" | shasum -a 256 -c - &&
  mkdir -p "$HOME/.cache/dafny-4.11.0" && unzip -q "$DL/$ZIP" -d "$HOME/.cache/dafny-4.11.0"
export PATH="$HOME/.cache/dafny-4.11.0/dafny:$PATH"
npx lsc version && dafny --version   # 0.6.14 and 4.11.0+fcb2042d...
```

A failed check stops the chain before `unzip`.

Node 18 or newer (22 for `lsc guard`). There is no Linux arm64 Dafny zip.

## Configure

`lemmascript.json` at the package root. `unread-annotations` defaults to `warn`, and then a
misspelled `//@ ensure` is dropped and the run reports `0 verified, 0 errors` with exit 0.

```json
{ "unread-annotations": "error" }
```

The default string model is Unicode scalar values, not JavaScript UTF-16. For UTF-16 semantics add
`"string-semantics": "javascript-utf16"` with `"dafny-library": "local"` (that rules out Dafny `Std`
imports). `npx lsc config` prints the options in effect.

`LemmaScript-files.txt` lists the files to verify, one per line: a path and a timeout in seconds.
Nothing else. A third column is passed to Dafny verbatim, and a flag there can make a run check
nothing.

```text
src/policy/redact.ts 60
```

## Write the contract

```ts
//@ backend dafny
export function stripSecret(text: string, secret: string): string {
  //@ verify
  //@ contract Removes every occurrence of secret, so the output never contains it.
  //@ requires secret.length > 0
  //@ ensures !\result.includes(secret)
  //@ ensures \result.length <= text.length
  let s = text;
  while (s.includes(secret)) {
    //@ invariant s.length <= text.length
    //@ decreases s.length
    const i = s.indexOf(secret);
    s = s.slice(0, i) + s.slice(i + secret.length);
  }
  return s;
}
```

Annotations: `requires`, `ensures` (with `\result`), `invariant`, `decreases`, `assert`, `ghost let`,
`type x nat`, `contract` (prose) and `verify` (opt a function in). Spec expressions allow `forall`,
`exists`, `==>` and `<==>`. In the trials, replacing the `while` with one pass failed the
postcondition with a counterexample of the secret twice over, and dropping the `requires` failed
termination: both are real bugs (a single `replaceAll` leaves the secret behind; an empty secret
loops forever).

## Check

```sh
npx lsc check --backend=dafny                   # batch over LemmaScript-files.txt
npx lsc regen --backend=dafny src/policy/redact.ts   # after editing the TypeScript; keeps proof additions
npx lsc info --typed src/policy/redact.ts       # contract JSON; bodyKinds shows any assume
npx lsc runs --json                             # what verification caught, from .lemmascript/
```

`lsc check` with no file argument is the batch mode. A directory argument fails with `EISDIR`,
although llms.txt shows `lsc check src/`. The generated `.dfy.gen` and the `.dfy` proof file sit
beside the source; commit both and fail the gate when they are stale (`git diff --exit-code`).

Errors point at the generated `.dfy` lines, not the TypeScript lines. The `.dfy` mirrors the source
line for line with the same names, so map back by name. Front-end rejections such as
`Unsupported expression` carry no location, and `lsc` stops at the first one.

## The model is not JavaScript

- `number` is a mathematical integer (or exact real). There is no 2^53 limit, no NaN, Infinity or
  -0, and no int32 wrap. `nextId(n) = n + 1` with `ensures \result > n` verifies, yet
  `nextId(2 ** 53) > 2 ** 53` is false at runtime. `**`, `>>>`, `Math.sqrt` and `Math.pow` have no
  lowering.
- Strings are Unicode scalars by default (above).
- Cross-file calls become axioms that carry the callee's contract. The caller is sound only if the
  callee's file is also verified.
- `//@ assume`, `havoc`, `autohavoc`, `extern`, `declare-type` and type overrides are trusted and
  unchecked. They need the owner's review.
- `lsc guard` wrappers check `requires` at runtime but not `type x nat`, integrality or the safe
  integer range.

State these assumptions in the registry entry's `notes`, and add a test at the boundaries the model
ignores (negative, non-integer, above 2^53, non-ASCII text).

## Gates CI must own

The tool's additions-only check rejects `assume`, `{:axiom}`, `{:verify false}` and added `requires`
in `.dfy` additions, but trials made a buggy function verify five other ways. The gate therefore:

1. Sets `"unread-annotations": "error"`, and fails any `//@ verify` function with zero verified
   conditions.
2. Rejects any `include` line added to a `.dfy` file.
3. Allows only the path and timeout columns in `LemmaScript-files.txt`: no flags column.
4. Lists every callee file that a verified function imports.
5. Runs `dafny audit` over every `.dfy` file, passed explicitly, against a reviewed baseline
   (written once without `--compare-report`, then committed):
   `dafny audit src/policy/redact.dfy src/policy/within.dfy --report-file spec/AUDIT.md --compare-report`.
   Auditing one file can miss an axiom in another.
6. Puts `*.dfy`, `*.dfy.gen`, `LemmaScript-files.txt` and `lemmascript.json` under CODEOWNERS.

Do not run `lsc claimcheck` on private code: it sends contracts to a hosted model. Its
`--claims-only` mode extracts claim pairs locally.

## Register it

```toml
[[spec]]
id = "redact-core"
title = "Redaction never leaves the secret in its output"
kind = "invariant"
tool = "lemmascript"
status = "conformance"
gate = "advisory"
artefacts = ["src/policy/redact.ts", "src/policy/redact.dfy", "lemmascript.json", "LemmaScript-files.txt"]
covers = ["src/policy/redact.ts"]
requires = ["node", "lemmascript", "dafny"]
check = ["npm", "run", "--silent", "spec:redact"]
properties = ["stripSecret"]
conformance = "The verified function is the shipped code."
notes = "Integer and Unicode-scalar string model; boundary cases are in test/redact.test.ts."
```

`spec:redact` runs `lsc check --backend=dafny src/policy/redact.ts` (one run per file the entry
verifies, callee files included), the staleness diff, and the audit compare over every `.dfy` file.
ci-local runs every entry's `check` on pre-push, so an entry checks only its own files. The batch
over all of `LemmaScript-files.txt` runs by dispatch or nightly.

## PR verification block

```markdown
| Entry | Tool | Command | Commit | Result |
|---|---|---|---|---|
| redact-core | lemmascript 0.6.14, Dafny 4.11.0 | `npm run spec:redact` | abc1234 | 4 verified, 0 errors; audit unchanged; generated files fresh |
```

## References

- AI docs: https://lemmascript.org/llms.txt and https://docs.lemmascript.org/llms.txt (they show
  `lsc check src/`, which fails in 0.6.14). Source and SPEC.md: https://github.com/midspiral/LemmaScript
  (MIT, v0.6.14 is commit 59e3366).
- Upstream skills: midspiral/lemmascript-skills has no licence. Link to it, never copy from it.
- The reusable upstream workflow clones LemmaScript `main` and builds lsc from source; do not call it
  as-is. Run the local gate instead.
- Registry and loop: `spec-first`. Backend details and the audit ratchet: `dafny-reference-model`.
