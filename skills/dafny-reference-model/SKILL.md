---
name: dafny-reference-model
description: >-
  Load when writing a Dafny reference model with proofs, using Dafny-generated JavaScript as a
  test-only oracle for a differential test, auditing .dfy files (including LemmaScript output), or
  when a registry entry has tool = "dafny". Covers the sha256-checked 4.11.0 install, dfyconfig.toml,
  the verify, format and audit gate, exit codes, the oracle recipe, and why generated JavaScript
  never ships.
---

# Dafny reference models

Dafny is a language with verification built in: contracts, lemmas and loop invariants are proved by
Z3, one method at a time. Here it has two jobs. It is LemmaScript's backend, and it is a reference
model: a small pure definition of a rule, proved to have its properties, then compiled to JavaScript
as an oracle that the real implementation is tested against.

## When to use

- A pure rule in code that is not TypeScript (Ruby, Python, C#, Rust): model it, prove it, and
  compare the real code with the oracle.
- A TypeScript rule where you want a proved oracle beside the code rather than proofs in place.
- Auditing `.dfy` files that LemmaScript generated.

Do not use it for interleavings or concurrent writers (use `quint-spec`). Never ship the generated
JavaScript: it is a CommonJS script with no exports or typings, unbounded integers become BigNumber
objects, and its sets and maps are arrays with linear-scan membership, so they scale quadratically.

## Install (pinned, checked)

Use the release zip. It is self-contained (.NET 8 runtime, Z3 4.12.1 and 4.14.1), so `verify` needs
no other install. Unpack it only when its sha256 matches: on another platform, put that platform's
zip name and digest from the table into `ZIP` and the `echo` line.

```sh
DL="$(mktemp -d)"; ZIP=dafny-4.11.0-arm64-macos-13.zip   # keep downloads out of the repo
gh release download v4.11.0 -R dafny-lang/dafny -p "$ZIP" --dir "$DL" &&
  echo "c90c75e7d5db9c6ccbb7127840dfe43f0ac938b039a7ebed146d8ead383a572f  $DL/$ZIP" | shasum -a 256 -c - &&
  mkdir -p "$HOME/.cache/dafny-4.11.0" && unzip -q "$DL/$ZIP" -d "$HOME/.cache/dafny-4.11.0"
export PATH="$HOME/.cache/dafny-4.11.0/dafny:$PATH"
dafny --version                                   # 4.11.0+fcb2042d...
```

A failed check prints `FAILED` and stops the chain before `unzip`.

| Asset | sha256 |
|---|---|
| dafny-4.11.0-arm64-macos-13.zip | c90c75e7d5db9c6ccbb7127840dfe43f0ac938b039a7ebed146d8ead383a572f |
| dafny-4.11.0-x64-macos-13.zip | 5fc0de946c5b2fad33f16bd22a5b06f4fd0dfa7f6d770284237e3f1f3ca9f73d |
| dafny-4.11.0-x64-ubuntu-22.04.zip | a46a9ff7cdd720f7955854c78e95df13f4cfe6b80691b05f8654fe19e8267179 |
| dafny-4.11.0-x64-windows-2022.zip | 3653f05a111ca21e234709ea7b25ce96083fd6c6f10484256ba54110dbc0654d |

There is no Linux arm64 zip. The NuGet `dafny` tool ships without Z3 and needs `--solver-path`. The
Homebrew formula is deprecated and runs whatever `z3` is on `PATH`, unchecked. The bundled .NET 8 is
past end of support.

## Project file

```toml
# dfyconfig.toml
includes = ["spec/dafny/**/*.dfy"]

[options]
# The next release's defaults. 4.11.0 accepts them; set them now.
type-system-refresh = true
general-traits = "datatype"
general-newtypes = true
```

Keep models pure and first-order: datatypes, sets, maps, sequences and bounded integer newtypes. Avoid
classes, lambdas with `reads` clauses, datatypes that extend traits, and bitvectors. Open soundness
reports sit in exactly those areas, and 4.11.0 lacks an unreleased fix for auto-induction (#6367).
The proof is evidence about the model; the differential test is the evidence about the code.

## A model

```dafny
// spec/dafny/SemVer.dfy
module SemVer {
  newtype u32 = x: int | 0 <= x < 0x1_0000_0000  // compiles to a plain JS number
  newtype i8 = x: int | -128 <= x < 128
  datatype Version = Version(major: u32, minor: u32, patch: u32)

  function Compare(a: Version, b: Version): i8 {
    if a.major != b.major then (if a.major < b.major then -1 else 1)
    else if a.minor != b.minor then (if a.minor < b.minor then -1 else 1)
    else if a.patch != b.patch then (if a.patch < b.patch then -1 else 1)
    else 0
  }
  predicate Le(a: Version, b: Version) { Compare(a, b) <= 0 }

  lemma Antisymmetric(a: Version, b: Version)
    ensures Compare(a, b) == -Compare(b, a)
    ensures Compare(a, b) == 0 <==> a == b
  {}
  lemma Transitive(a: Version, b: Version, c: Version)
    requires Le(a, b) && Le(b, c)
    ensures Le(a, c)
  {}
  lemma Total(a: Version, b: Version) ensures Le(a, b) || Le(b, a) {}
}
```

## Gate

The registry `check` runs this script: the proofs, the audit, then the oracle test (next section).
It took 4 seconds in the trial.

```sh
# scripts/spec-semver.sh, run by "spec:semver": "sh scripts/spec-semver.sh"
set -eu
dafny format --check dfyconfig.toml
dafny verify dfyconfig.toml | tee /dev/stderr | grep -qE 'finished with [1-9][0-9]* verified, 0 errors'
dafny audit dfyconfig.toml --report-file spec/dafny/AUDIT.md --compare-report
rm -rf test/oracle && mkdir test/oracle            # the oracle is rebuilt by every run; git-ignore it
dafny translate js --include-runtime --output test/oracle/SemVer.js spec/dafny/SemVer.dfy
{ cat test/oracle/SemVer.js; printf '\nmodule.exports = { _dafny, SemVer };\n'; } > test/oracle/semver.cjs
node --experimental-strip-types --test test/semver.oracle.test.ts
```

Create the baseline once without `--compare-report` and commit it; with the flag and no baseline the
audit exits 2. `--compare-report` is an exact-text snapshot, not a one-way ratchet: it fails when a
finding is added and also when one is removed, so regenerate the baseline in the same reviewed
commit that removes an axiom. A mismatch writes `AUDIT.md.expect` beside the baseline.

The audit is the only check that sees an axiom. `lemma {:axiom} Anything() ensures false` passes
`dafny verify` with exit 0; the audit compare fails with exit 2. `--analyze-proofs` also flags a proof
that relies on contradictory assumptions, but it warns about unneeded asserts too, and warnings fail
`verify`. Reject `{:axiom}`, `assume`, `{:verify false}`, `decreases *`, `--allow-axioms` and
`--allow-warnings` in an agent's change unless the owner has reviewed them.

Exit codes: 0 success, 1 command-line error, 2 parse, resolution or warning (and an audit mismatch),
3 compile error, 4 verification failure, 5 `format --check` found unformatted files. A gate script
cannot tell an audit mismatch from a warning by exit code alone.

For agents, `--json-output` prints JSON lines. Key on `source`, `severity`, the location and
`relatedInformation`. `errorId` is null on verifier diagnostics, `line` is 1-based while `character`
is 0-based, and the message text changes in the next release ("might not hold" becomes "could not be
proved"), so do not match on wording. To iterate on one lemma use `--filter-symbol=SemVer.Transitive`.
Set `resource-limit` in `[options]` at about five times the largest resource count that
`dafny measure-complexity --mutations 10 --log-format csv dfyconfig.toml` reports, and rerun that on
every Dafny or Z3 upgrade.

## Use the model as an oracle

The generated code requires `bignumber.js`: `npm install --save-dev --save-exact bignumber.js@11.1.5`.
The gate's `printf` line adds the exports the generated script lacks. Never commit the generated
files: a committed oracle can drift from `SemVer.dfy` while the entry still says `conformance`.

```ts
// test/semver.oracle.test.ts: compare the shipped comparator with the verified model.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { compare } from "../src/semver.ts";

const { SemVer } = createRequire(import.meta.url)("./oracle/semver.cjs"); // test-only
const model = (a: any, b: any) => SemVer.__default.Compare(
  SemVer.Version.create_Version(a.major, a.minor, a.patch), SemVer.Version.create_Version(b.major, b.minor, b.patch));

test("compare agrees with the verified model on every version up to 3.3.3", () => {
  const vs = [];
  for (let major = 0; major < 4; major++) for (let minor = 0; minor < 4; minor++)
    for (let patch = 0; patch < 4; patch++) vs.push({ major, minor, patch });
  for (const a of vs) for (const b of vs) assert.equal(compare(a, b), model(a, b), `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
});
```

Oracle traps: bounded newtypes compile to JS numbers, but `int` and `nat` need BigNumber values (a
plain number throws `a.plus is not a function`). Strings are sequences of code points: wrap inputs
with `_dafny.Seq.UnicodeFromString`. Bitvector operations are miscompiled on the JS target (#6647).
Importing the oracle sets BigNumber's modulo mode for the whole process. `dafny build`, `run` and
`test` with `-t:js` run `node` from the current directory, so `bignumber.js` must resolve there.
Never import the oracle from shipped code.

## Register it

The entry says `conformance` only while its `check` rebuilds the oracle and runs the differential
test, as the gate script does:

```toml
[[spec]]
id = "semver-order"
title = "Version comparison is a total order"
kind = "algorithm"
tool = "dafny"
status = "conformance"
artefacts = ["spec/dafny/SemVer.dfy", "dfyconfig.toml", "spec/dafny/AUDIT.md", "scripts/spec-semver.sh",
  "test/semver.oracle.test.ts"]
covers = ["src/semver.ts"]
requires = ["dafny", "node"]
check = ["npm", "run", "--silent", "spec:semver"]
properties = ["Antisymmetric", "Transitive", "Total"]
conformance = "test/semver.oracle.test.ts compares src/semver.ts with the Dafny oracle on every version up to 3.3.3."
```

## PR verification block

```markdown
| Entry | Tool | Command | Commit | Result |
|---|---|---|---|---|
| semver-order | Dafny 4.11.0 | `npm run spec:semver` | abc1234 | 8 verified, 0 errors; audit unchanged; oracle test 4096 pairs pass |
```

## References

- There is no llms.txt on dafny.org and no official agent skill or MCP server. The reference manual
  and User Guide: https://dafny.org/latest/DafnyRef/DafnyRef (source in `docs/DafnyRef/` of
  dafny-lang/dafny; v4.11.0 is commit fcb2042d). The User Guide still documents
  `measure-complexity --iterations`; 4.11.0 takes `--mutations`.
- TypeScript decision code: `lemmascript-proof`. Registry and loop: `spec-first`.
