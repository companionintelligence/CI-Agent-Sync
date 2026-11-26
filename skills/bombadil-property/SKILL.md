---
name: bombadil-property
description: >-
  Load when stating what a web UI may and must do over time (no secret in the URL, no success
  without a success response, a control disabled while a request is in flight, a spinner that
  resolves), running Bombadil against a local build, or when a registry entry has tool = "bombadil".
  Covers Bombadil 0.8.0 LTL properties, extractors, weighted actions, real and virtual time,
  reachability witnesses, exit codes, secrets in --header or --cookie, and the Chromium-only limits.
---

# Bombadil properties

Bombadil explores a web page at random in Chromium and checks temporal properties on every state it
captures. You write a TypeScript module that exports properties (formulas over values extracted
from the page) and action generators. It finds counterexamples; it proves nothing, and a green run
can be vacuous.

## When to use

Use it for DOM web UIs run locally against stubbed APIs: consent and sign-in screens, forms, settings,
opt-outs. Typical properties: no token in the URL, no telemetry request after opt-out, no success
message without a success response, a button disabled while its request is in flight.

Do not use it for Tauri on macOS (WKWebView), Capacitor iOS, WebXR or canvas content, or
`chrome-extension://` pages (rejected as an origin). It is random exploration, not a crawler, so it
is no replacement for a link checker. Never point it at production or at a real account.

## Install (pinned)

```sh
npm install --save-dev --save-exact @antithesishq/bombadil@0.8.0 typescript@5.9.3
npm audit signatures            # the 0.8.0 tarball carries SLSA provenance
npx bombadil --version          # bombadil 0.8.0
```

The package bundles binaries for macOS arm64 and Linux x64 and arm64. On Intel macOS or Windows the
install succeeds and the run fails. Chrome or Chromium must be installed (set `CHROME` if it is not
found). Call the CLI directly; `antithesishq/bombadil-action@v3` runs a stale bundle that ignores its
`cookies` input.

## Write the spec

```ts
// bombadil/save.spec.ts
import { always, eventually, now } from "@antithesishq/bombadil";
// Import extract from the browser module: the root export types `state` as unknown.
import { actions, extract, weighted } from "@antithesishq/bombadil/browser";
import { defaultActions } from "@antithesishq/bombadil/browser/defaults";

// The defaults: no uncaught exceptions, unhandled rejections or console errors, no HTTP status >= 400.
export {
  noConsoleErrors, noHttpErrorCodes, noUncaughtExceptions, noUnhandledPromiseRejections,
} from "@antithesishq/bombadil/browser/defaults/properties";

// A spec must export an action generator. A rare Wait keeps a move available while every
// control is disabled; without it the run stops with "no actions available".
export const exploration = weighted([[100, defaultActions], [1, actions(() => ["Wait"])]]);

const status = extract((s) => s.document.querySelector("#status")?.getAttribute("data-status") ?? "missing");
const saveEnabled = extract((s) => {
  const button = s.document.querySelector("#save");
  return button instanceof HTMLButtonElement && !button.disabled;
});
const url = extract((s) => s.navigationHistory.current.url);

// Safety: Save cannot be pressed again while a save is in flight.
export const saveDisabledWhileSaving = always(() => !(status.current === "saving" && saveEnabled.current));

// Bounded liveness. An unbounded eventually never fails on a finite run. Reload is a default
// action and drops an in-flight save, so "idle" also resolves it.
const resolved = ["saved", "error", "idle"];
export const saveResolvesWithin3s = always(
  now(() => status.current === "saving").implies(
    eventually(() => resolved.includes(status.current)).within(3, "seconds"),
  ),
);

// No credential ever appears in the address bar.
export const noTokenInUrl = always(() => !/[?#&]access_token=/.test(url.current));

// Reachability witnesses: a pass fails if exploration never sees a save in flight or a
// completed save, so the properties above cannot pass vacuously. Each clock's pass takes one.
export const reachesSaving = eventually(() => status.current === "saving").within(20, "seconds");
export const reachesSaved = eventually(() => status.current === "saved").within(20, "seconds");
```

Formulas: `always`, `eventually`, `next`, `now`, with `.and`, `.or`, `.implies`, `.not` and
`.within(n, "milliseconds" | "seconds")`. There is no `until`. Extractors run in the page and read
`document`, `window` and `navigationHistory`; read a cell's `.current` only inside a formula, never at
the top level of the module.

## Run both clocks

Real time rarely reaches states behind a timer. Chrome's virtual time reaches them, but then timers
fire before the next capture, so short-lived states vanish. Each mode checks a different half, so run
both, and give each pass only the witness its clock reaches every time. In the trial, real time
reached "saved" within 20 seconds in 6 of 10 runs, a flaky check, and virtual time never saw
"saving". Split that way, each pass met its witness in 5 of 5 runs:

```ts
// bombadil/save-rt.spec.ts: real time sees "saving" at once but reaches "saved" only by chance.
export {
  exploration, noConsoleErrors, noHttpErrorCodes, noTokenInUrl, noUncaughtExceptions,
  noUnhandledPromiseRejections, reachesSaving, saveDisabledWhileSaving, saveResolvesWithin3s,
} from "./save.spec.ts";
```

```ts
// bombadil/save-vt.spec.ts: the virtual-time pass never sees "saving", so it drops reachesSaving.
export {
  exploration, noConsoleErrors, noHttpErrorCodes, noTokenInUrl, noUncaughtExceptions,
  noUnhandledPromiseRejections, reachesSaved,
} from "./save.spec.ts";
```

```sh
mkdir -p .bombadil
npx tsc -p bombadil/tsconfig.json        # Bombadil strips types and never checks them
T=25s                                    # the registered check; 60s or more by dispatch or nightly
npx bombadil browser test --headless --exit-on-violation --time-limit $T \
  --output-path .bombadil/rt.bin --output-path-overwrite http://127.0.0.1:5173/ bombadil/save-rt.spec.ts
npx bombadil browser test --headless --exit-on-violation --chrome-virtual-time-policy Advance --time-limit $T \
  --output-path .bombadil/vt.bin --output-path-overwrite http://127.0.0.1:5173/ bombadil/save-vt.spec.ts
npx bombadil trace .bombadil/rt.bin --json   # one JSON object per state
```

ci-local runs every entry's `check` on pre-push, and long exploration belongs to dispatch or nightly
runs. So the registered `check` is the short pass: `tsc` and 25 seconds in each clock, enough for
the 20-second witnesses. It took about 55 seconds in the trial, before the dev server's start-up.
Run the same passes with `--time-limit 60s` or more by dispatch or nightly.

In the trial's 25-second passes, a page that left Save enabled while saving failed the real-time
pass within 3 seconds. Run in virtual time with every property of `save.spec.ts`, it passed every
safety property and failed only on the `reachesSaving` witness, at 21 seconds. `--output-path`
refuses an existing file without `--output-path-overwrite`, and its folder must exist. The spec's
`tsconfig.json`:

```json
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true,
    "noEmit": true, "allowImportingTsExtensions": true, "lib": ["ES2022", "DOM"], "types": [] },
  "include": ["*.spec.ts"] }
```

## Exit codes and evidence

- In 0.8.0 exit 2 means a violation and also a usage error (unknown flag, bad duration). The terminal
  driver exits 1 on a violation. Treat any non-zero exit as a failure and read violations from
  `bombadil trace --json`.
- A violation report names the property, prints its formula and the extracted values that made it
  false. A spec error is often opaque: a misspelled import gives `not a callable function`, a bad time
  unit in `.within()` is dropped without an error (so the bound can never fail), and a spec with no
  action generator fails at start. Run `tsc` first; it catches the first two.
- States are sampled. A transition property must tolerate skipped intermediate states.
- Exploration is random, so a pass is evidence only if it passes every time. Run a new spec several
  times before you register it; a witness that is met only sometimes belongs to the other clock or
  needs a longer bound.
- `--reproduce` is best effort. The printed reproduce line drops `--chrome-virtual-time-policy`; add
  it back. A reproduce that exits 0 does not prove a fix.
- Default script instrumentation (`--instrument-javascript files,inline`) rewrites scripts and breaks
  pages that use Subresource Integrity or hash-based CSP without an error. Add a "page booted"
  property and restrict instrumentation on such builds.

## Secrets and data

- Never pass a real token or session through `--header` or `--cookie`: the printed reproduce line
  echoes both verbatim into logs. Use a stubbed API and a test-only session.
- `bombadil browser inspect` serves traces on all interfaces (port 1073 by default); the port can
  change but the address cannot. Traces hold screenshots and DOM values. Run it only on a trusted
  network, stop it after, and keep traces out of git (`.bombadil/`).

## Register it

```toml
[[spec]]
id = "save-flow"
title = "Save: disabled while saving, resolves within 3 s, no token in the URL"
kind = "ui-flow"
tool = "bombadil"
status = "checked"
artefacts = ["bombadil/save.spec.ts", "bombadil/save-rt.spec.ts", "bombadil/save-vt.spec.ts", "bombadil/tsconfig.json"]
covers = ["src/settings/**"]
requires = ["node", "bombadil", "chromium"]
check = ["npm", "run", "--silent", "spec:save-flow"]
timeout_seconds = 120
properties = ["saveDisabledWhileSaving", "saveResolvesWithin3s", "noTokenInUrl"]
notes = "Dev server with the API stubbed. check: tsc and 25 s in each clock. 60 s passes by dispatch or nightly."
```

## PR verification block

Bombadil 0.8.0 has no seed: record the time limits and keep the trace files for `--reproduce`.

```markdown
| Entry | Tool | Command | Commit | Bounds | Result |
|---|---|---|---|---|---|
| save-flow | bombadil 0.8.0, Chrome <version> | `npm run spec:save-flow` | abc1234 | 25 s real time + 25 s virtual time | no violation; witnesses reached |
```

## References

- AI docs: there is no `/llms.txt`. https://antithesishq.github.io/bombadil/llms-full.txt points to the
  plain-text manuals written for agents, such as
  https://antithesishq.github.io/bombadil/browser/bombadil-manual.txt. Some manual examples import
  `extract` from the root module, which fails strict `tsc`.
- Upstream skills: none in 0.8.0 (the skill pull requests are unmerged). Do not let a future
  `bombadil skill setup` write into agent folders that CI-Agent-Sync manages.
- Upstream's contribution policy forbids LLM-written issues and pull request descriptions: report
  upstream bugs through a person.
- Registry and loop: `spec-first`. Single components: `storybook-contract`.
