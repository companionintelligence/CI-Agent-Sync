---
name: quint-spec
description: >-
  Load when a rule is about state over time: a protocol, lifecycle, retry, lease, queue, consent
  flow or race, or when a registry entry has tool = "quint". Covers modelling in Quint 0.34.0,
  invariant and observation definitions, quint typecheck, run, test and bounded verify with a
  per-run Apalache port, vacuity witnesses, QUINT_HOME and the unverified first-use downloads, and
  replaying quint run --mbt traces in a TypeScript test.
---

# Quint specs

Quint is an executable specification language on the logic of TLA+. Use it to model a design,
simulate it in seconds, model-check it with Apalache or TLC, and replay its traces against the code.
It checks the design, not the code: tie the code to it with trace replay.

## When to use

Use it for protocols, state machines and races: sign-in and consent steps, lifecycles with expiry,
retries, leases, outboxes, anything where two actors or two steps can interleave.

Do not use it for a single pure function (use `lemmascript-proof`), data validation
(`effect-schema-contract`), UI (`storybook-contract`, `bombadil-property`) or string processing:
Quint has no string operations, no recursion and no symmetry sets.

## Install (pinned)

```sh
npm install --save-dev --save-exact @informalsystems/quint@0.34.0
export QUINT_HOME="$HOME/.cache/quint-0.34.0"   # shared backend cache, keyed on the version; default ~/.quint
npx quint --version                             # 0.34.0
```

Node 18 or newer. `quint verify` needs Java 21 or newer (Apalache 0.62.x). Homebrew ships 0.34.0;
nixpkgs lags.

First use downloads two backends with no checksum check: the Rust evaluator (on the first `run` or
`test`, through the unauthenticated GitHub API, 60 requests an hour per address) and the 192 MB
Apalache archive (on the first `verify`). Pre-seed `QUINT_HOME` from checked release assets instead
(macOS arm64 shown; the digests for every platform are in CI-Agent-Sync's
`integrations/verification/toolchains.yaml`, and `agentctl spec toolchains` reports what is
installed):

```sh
gh release download v0.62.4 -R apalache-mc/apalache -p apalache.tgz -p sha256sum.txt
grep ' apalache.tgz$' sha256sum.txt | shasum -a 256 -c -
mkdir -p "$QUINT_HOME/apalache-dist-0.62.4" && tar -xzf apalache.tgz -C "$QUINT_HOME/apalache-dist-0.62.4"

gh release download evaluator/v0.8.0 -R quint-co/quint -p quint_evaluator-aarch64-apple-darwin.tar.gz
shasum -a 256 quint_evaluator-aarch64-apple-darwin.tar.gz   # compare with the digest below
gh release view evaluator/v0.8.0 -R quint-co/quint --json assets --jq '.assets[] | "\(.digest) \(.name)"'
mkdir -p "$QUINT_HOME/rust-evaluator-v0.8.0"
tar -xzf quint_evaluator-aarch64-apple-darwin.tar.gz -C "$QUINT_HOME/rust-evaluator-v0.8.0"
```

Git-ignore `_apalache-out/` (Apalache writes it to the working directory) and trace folders.

## Model

Keep the model small and finite: a few ids, small bounds, fixed-domain maps and sets.

```quint
// spec/quint/retryQueue.qnt
module retryQueue {
  type Status = Queued | InFlight | Done | Dropped
  pure val JOBS: Set[str] = Set("a", "b", "c")
  pure val MAX_TRIES: int = 3

  var status: str -> Status
  var tries: str -> int

  pure def isFinal(s: Status): bool = s == Done or s == Dropped

  action init = all { status' = JOBS.mapBy(_ => Queued), tries' = JOBS.mapBy(_ => 0) }
  action send(job: str): bool = all {
    status.get(job) == Queued, tries.get(job) < MAX_TRIES,
    status' = status.set(job, InFlight), tries' = tries.setBy(job, n => n + 1),
  }
  action ack(job: str): bool = all {
    status.get(job) == InFlight, status' = status.set(job, Done), tries' = tries,
  }
  action nack(job: str): bool = all {
    status.get(job) == InFlight,
    status' = status.set(job, if (tries.get(job) < MAX_TRIES) Queued else Dropped), tries' = tries,
  }
  // Stutter once every job is final, so `step` stays enabled.
  action idle = all { JOBS.forall(j => isFinal(status.get(j))), status' = status, tries' = tries }
  action step = {
    nondet job = JOBS.oneOf()
    any { send(job), ack(job), nack(job), idle }
  }

  invariant triesBounded = JOBS.forall(j => tries.get(j) <= MAX_TRIES)
  invariant droppedOnlyAfterLastTry =
    JOBS.forall(j => status.get(j) == Dropped implies tries.get(j) == MAX_TRIES)
  observation someDone = JOBS.exists(j => status.get(j) == Done)
  observation someDropped = JOBS.exists(j => status.get(j) == Dropped)
}
```

```quint
// spec/quint/retryQueueTest.qnt
module retryQueueTest {
  import retryQueue.* from "./retryQueue"
  run ackOnFirstTryTest = init.then(send("a")).then(ack("a"))
    .expect(status.get("a") == Done and tries.get("a") == 1)
  // A step that must be refused goes last: `.fail()` assigns no variables.
  run noSendAfterDropTest = init.then(send("a")).then(nack("a")).then(send("a")).then(nack("a"))
    .then(send("a")).then(nack("a")).then(send("a").fail())
  // Also a progress check: `reps` fails with QNT513 when no action is enabled.
  run randomWalkTest = init.then(20.reps(_ => step)).expect(triesBounded and droppedOnlyAfterLastTry)
}
```

Rules that save turns:

- Every action assigns every state variable. A missing assignment is reported at the enclosing
  `any`, not at the action that forgot it.
- Built-in names cannot be reused (QNT101): `fail` and `item` are taken.
- `invariant` and `observation` definitions (new in 0.34.0) are collected by `run` and `verify`.
  `--invariant` or `--invariants` replaces them; `--witnesses` is deprecated.
- `quint test` runs definitions whose names end in `Test` (or `--match`) and fails when none match.
- Record spread differs from JavaScript: explicit fields win whatever their order.
- Type and effect errors are a generic QNT000 with unifier text; read the location, then the action.

## Fast gate (seconds, pre-push)

```sh
quint typecheck spec/quint/retryQueue.qnt
quint test spec/quint/retryQueueTest.qnt --main retryQueueTest --max-samples 10000
quint run spec/quint/retryQueue.qnt --max-samples 10000 --max-steps 20 --verbosity 1
quint run spec/quint/retryQueue.qnt --observation someDone --max-samples 10000 --max-steps 20 --verbosity 1
quint run spec/quint/retryQueue.qnt --observation someDropped --max-samples 10000 --max-steps 20 --verbosity 1
quint run spec/quint/bugs/retryQueue.qnt --max-samples 10000 --max-steps 20 --verbosity 1   # must exit 1
```

Put these in a package script (`spec:retry-queue`) and point the registry `check` at it. The planted
bug is a copy of the model with one deliberate mistake (here `nack` drops after the second try); the
script asserts that it fails. `--observation O` exits 1 when no trace reaches `O`, so run it once per
observation: several flags in one run stop at the first one reached.

## Deep gate (minutes, dispatch or nightly)

```sh
quint verify spec/quint/retryQueue.qnt --max-steps 10 --server-endpoint localhost:18823 --verbosity 1 < /dev/null
quint verify spec/quint/retryQueue.qnt --max-steps 10 --observation someDropped --server-endpoint localhost:18823 < /dev/null
quint verify spec/quint/retryQueue.qnt --backend tlc --server-endpoint localhost:18823 < /dev/null
```

- Give every concurrent run its own `--server-endpoint` port. Runs on the default `localhost:8822`
  share one Apalache server and the second fails when the first exits. The TLC backend also
  transpiles through that server, so it needs the port too.
- Apalache is bounded by `--max-steps` (default 10) and slows sharply with depth; growing lists and
  maps cost far more than fixed-domain maps and sets.
- Check temporal and action properties only with `--backend tlc`. On Apalache, `--temporal` stops at
  a y/N prompt and, with stdin closed, exits 0 having checked nothing, even on a violating spec.

## Exit 0 is not evidence

- `--seed` lowers the default `--max-samples` to 1, so a seeded run checks one trace. Always pass
  `--max-samples` with `--seed`. Seeds are tied to the backend and the Quint version: keep failing
  traces as fixtures, not only their seeds.
- `quint run` ends a stuck trace silently and TLC runs with deadlock checking off. Keep a `reps` test.
  In the trial, a variant whose `nack` never dropped a job passed `quint run` with exit 0 and only a
  warning that no trace reached `someDropped`; the `reps` test (QNT513) and the
  `--observation someDropped` run both failed it.
- `--search-observations` prints `was not observed` and still exits 0. Gate on `--observation`.
- Open issues that give a false pass on 0.34.0: Apalache can drop an exception while reporting a
  violation and exit 0 with no result line (quint-co/quint#2074); TLC can check a different model
  when a qualified name collides after transpiling (#2072). Require the result line
  (`[ok] No violation found`, `[violation]`, `[observed]`) and cross-check `verify` against `run`.
- `--out` JSON is large and its line numbers are zero-based. `--out-itf` does not silence output.

## Replay traces against the code

Only `quint run --mbt` records the action taken and its nondeterministic picks. `quint verify` has no
`--mbt`, and the TLC backend writes no ITF file.

```sh
quint run spec/quint/retryQueue.qnt --mbt --n-traces 20 --max-samples 100 --max-steps 12 \
  --seed 0x2a --out-itf 'traces/t_{seq}.itf.json' --verbosity 1    # --n-traces <= --max-samples
```

Each state carries `mbt::actionTaken` (`"send"`) and `mbt::nondetPicks`
(`{"job": {"tag": "Some", "value": "c"}}`; a pick the action did not use is tagged `None`). Values use the ITF
encodings `{"#bigint": "1"}`, `{"#map": [[k, v]]}`, `{"#set": []}`, `{"#tup": []}` and variants
`{"tag": "Queued", "value": {"#tup": []}}`. There is no official TypeScript connector. CI-Agent-Sync's
`src/itf.ts` exports `parseItfTrace`, `decodeItfValue`, `itfAction` and `itfPicks`; read its types
before you write the driver. The driver's shape:

```ts
// test/retryQueue.replay.test.ts (sketch: check the signatures in src/itf.ts)
for (const file of traceFiles) {
  const trace = parseItfTrace(readFileSync(file, "utf8"));
  const queue = new RetryQueue(["a", "b", "c"], 3);           // the implementation under test
  for (const [i, state] of trace.states.entries()) {
    const action = itfAction(state);                           // init, send, ack, nack, idle
    const { job } = itfPicks(state);
    if (action !== "init" && action !== "idle") assert.ok(queue[action](job), `${file}#${i} ${action}(${job}) refused`);
    assert.deepEqual(queue.snapshot(), { status: decodeItfValue(state.status), tries: decodeItfValue(state.tries) });
  }
}
```

Commit the generating command (seed, sample count, steps; it reproduces only on the pinned version
and backend), not the traces. When replay passes, the
entry can move to `status = "conformance"` with `conformance = "test/retryQueue.replay.test.ts
replays quint run --mbt traces"`.

## PR verification block

```markdown
| Entry | Tool | Command | Commit | Bounds | Result |
|---|---|---|---|---|---|
| retry-queue | quint 0.34.0, Apalache 0.62.4 | `npm run spec:retry-queue` | abc1234 | 10000 samples, 20 steps; verify 10 steps | pass; observations reached; planted bug fails |
```

## References

- AI docs: https://quint.sh/llms.txt (there is no llms-full.txt). Manual: https://quint.sh/docs/quint,
  model-based testing: https://quint.sh/docs/model-based-testing
- Upstream skills (Apache-2.0): `quint-lang` and `quint-modeling` in quint-co/quint `skills/`, read at
  95141d4691cce7e60104bdfcbc1d1b074f1cb789. Parts predate 0.34.0: they teach `--witnesses` and
  say piped REPL input needs the TypeScript backend. Do not also install the LLM kit's older skills
  of the same names.
- Registry and loop: `spec-first`.
