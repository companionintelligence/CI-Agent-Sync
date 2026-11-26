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

Quint is an executable specification language on the logic of TLA+. Model a design, simulate it in
seconds, model-check it with Apalache or TLC, and tie the code to it by replaying its traces.

## When to use

Use it for protocols, state machines and races: sign-in and consent steps, lifecycles with expiry,
retries, leases, outboxes, anything where two actors or two steps can interleave. Not for a single
pure function (`lemmascript-proof`), data validation (`effect-schema-contract`), UI
(`storybook-contract`, `bombadil-property`) or string processing: Quint has no string operations,
no recursion and no symmetry sets.

## Install (pinned)

```sh
npm install --save-dev --save-exact @informalsystems/quint@0.34.0
export QUINT_HOME="$HOME/.cache/quint-0.34.0"   # shared backend cache, keyed on the version; default ~/.quint
npx quint --version                             # 0.34.0
```

Node 18 or newer; `quint verify` needs Java 21 or newer. First use downloads two backends with no
checksum check: the Rust evaluator (first `run` or `test`, through the unauthenticated GitHub API,
60 requests an hour per address) and the 192 MB Apalache archive (first `verify`). Pre-seed
`QUINT_HOME` from checked release assets instead (macOS arm64 shown; every platform's digest is in
CI-Agent-Sync's `integrations/verification/toolchains.yaml`):

```sh
gh release download v0.62.4 -R apalache-mc/apalache -p apalache.tgz -p sha256sum.txt
grep ' apalache.tgz$' sha256sum.txt | shasum -a 256 -c -
mkdir -p "$QUINT_HOME/apalache-dist-0.62.4" && tar -xzf apalache.tgz -C "$QUINT_HOME/apalache-dist-0.62.4"

gh release download evaluator/v0.8.0 -R quint-co/quint -p quint_evaluator-aarch64-apple-darwin.tar.gz
echo "cc016a73031f8717f7c7b9f2a54eb21b15d58b2a1f1ee7f1750a225e00a76672  quint_evaluator-aarch64-apple-darwin.tar.gz" | shasum -a 256 -c -
mkdir -p "$QUINT_HOME/rust-evaluator-v0.8.0" && tar -xzf quint_evaluator-aarch64-apple-darwin.tar.gz -C "$QUINT_HOME/rust-evaluator-v0.8.0"
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

- Every action assigns every state variable. A missing assignment is reported at the enclosing
  `any`, not at the action that forgot it. Type and effect errors are a generic QNT000.
- Built-in names cannot be reused (QNT101): `fail` and `item` are taken.
- `invariant` and `observation` definitions (new in 0.34.0) are collected by `run` and `verify`;
  `--invariant` or `--invariants` replaces them, and `--witnesses` is deprecated.
- `quint test` runs definitions whose names end in `Test` (or `--match`) and fails when none match.
- Record spread differs from JavaScript: explicit fields win whatever their order.

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

- Give every concurrent run its own `--server-endpoint` port, TLC runs included (they transpile
  through the same server). Runs on the default `localhost:8822` share one Apalache server, and the
  second fails when the first exits.
- Apalache is bounded by `--max-steps` (default 10) and slows sharply with depth; growing lists and
  maps cost far more than fixed-domain maps and sets.
- Check temporal and action properties only with `--backend tlc`. On Apalache `--temporal` waits at
  a y/N prompt and, with stdin closed, exits 0 having checked nothing.

## Exit 0 is not evidence

- `--seed` lowers the default `--max-samples` to 1, so a seeded run checks one trace. Always pass
  `--max-samples` with `--seed`. Seeds are tied to the backend and the Quint version: keep failing
  traces as fixtures, not only their seeds.
- `quint run` ends a stuck trace silently and TLC runs with deadlock checking off. In the trial, a
  variant whose `nack` never dropped a job passed `quint run` (exit 0, one warning); the `reps` test
  (QNT513) and `--observation someDropped` both failed it.
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
(`{"job": {"tag": "Some", "value": "c"}}`) beside the model's variables, in ITF encodings such as
`{"#bigint": "1"}`, `{"#map": [[k, v]]}` and `{"tag": "Queued", "value": {"#tup": []}}`. There is no
official TypeScript connector; CI-Agent-Sync's `src/itf.ts` is a small strict decoder.
`parseItfTrace(text)` returns `{ vars, states, meta }` with every state decoded (`bigint`, `Map`,
`Set`, arrays, variants as `{ tag, value }`), `itfAction(state)` gives the action, `itfPicks(state)`
the picks (`Some(x)` as `x`, `None` as `undefined`), and `decodeItfValue` decodes one value. Copy it
at a pinned commit:

```ts
// test/retryQueue.replay.test.ts: drive the implementation through every model trace.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { itfAction, itfPicks, parseItfTrace } from "./itf.ts";   // CI-Agent-Sync src/itf.ts
import { RetryQueue } from "../src/queue/retryQueue.ts";

test("the queue follows every model trace", () => {
  for (const file of readdirSync("traces").filter((f) => f.endsWith(".itf.json"))) {
    const trace = parseItfTrace(readFileSync(`traces/${file}`, "utf8"));
    const queue = new RetryQueue(["a", "b", "c"], 3);
    trace.states.forEach((state, i) => {
      const action = itfAction(state);                  // init, send, ack, nack or idle
      const job = itfPicks(state).job as string;
      if (action === "send" || action === "ack" || action === "nack") {
        assert.ok(queue[action](job), `${file} state ${i}: ${action}(${job}) refused`);
      }
      const status = state.status as Map<string, { tag: string }>;
      const tries = state.tries as Map<string, bigint>;
      for (const j of ["a", "b", "c"]) {
        assert.equal(queue.statusOf(j), status.get(j)?.tag, `${file} state ${i}: status of ${j}`);
        assert.equal(BigInt(queue.triesOf(j)), tries.get(j), `${file} state ${i}: tries of ${j}`);
      }
    });
  }
});
```

In the trial, an implementation that dropped a job one try early failed at the first diverging state.
Commit the generating command (seed, sample count, steps), not the traces; it reproduces only on the
pinned version and backend. When replay passes, the registry entry moves to `conformance`:

```toml
[[spec]]
id = "retry-queue"
title = "Retry queue: send, acknowledge, refuse and drop after the last try"
kind = "state-machine"
tool = "quint"
status = "conformance"
artefacts = ["spec/quint/retryQueue.qnt", "spec/quint/retryQueueTest.qnt", "test/retryQueue.replay.test.ts"]
covers = ["src/queue/**"]
requires = ["node", "quint"]
check = ["npm", "run", "--silent", "spec:retry-queue"]
properties = ["triesBounded", "droppedOnlyAfterLastTry"]
conformance = "test/retryQueue.replay.test.ts replays quint run --mbt traces against src/queue/retryQueue.ts"
```

## PR verification block

```markdown
| Entry | Tool | Command | Commit | Bounds | Result |
|---|---|---|---|---|---|
| retry-queue | quint 0.34.0, Apalache 0.62.4 | `npm run spec:retry-queue` | abc1234 | 10000 samples, 20 steps; verify 10 steps | pass; observations reached; planted bug fails |
```

## References

- AI docs: https://quint.sh/llms.txt (no llms-full.txt). Manual: https://quint.sh/docs/quint and
  https://quint.sh/docs/model-based-testing. Registry and loop: `spec-first`.
- Upstream skills (Apache-2.0): `quint-lang` and `quint-modeling` in quint-co/quint `skills/` at
  95141d4691cce7e60104bdfcbc1d1b074f1cb789. They predate 0.34.0 (`--witnesses`, piped-REPL advice).
  The LLM kit ships older skills with the same names: do not install both.
