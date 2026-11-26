---
name: effect-schema-contract
description: >-
  Load when defining or changing a data contract at a boundary (wire format, config file, manifest,
  registry, webhook payload), publishing JSON Schema for other languages, adding property tests over
  generated data, or when a registry entry has tool = "effect-schema" or "property". Covers Effect 4
  (effect 4.1.6) Schema APIs and subpath imports, decoding with every error, a sound JSON Schema
  export, Standard Schema interop with Zod and Hono, and effect/Arbitrary properties.
---

# Effect Schema contracts

One Effect Schema is the contract for data that crosses a boundary. It decodes at runtime with an
exact path for every error, exports JSON Schema for consumers in other languages, and generates test
data for property tests. Effect 4 is a long-term-support line; its Schema core is stable.

## When to use

Use it for new boundaries: wire formats, config and store files, manifests, registries, tool and
intent payloads. Use `effect/Arbitrary` for properties over generated values.

Do not use it to rewrite a backend into Effect (Layer, HttpApi, effect/sql and friends stay out), or
to replace Zod where Zod already ships until a migration decision says so. The two meet through
Standard Schema.

## Install (pinned)

```sh
npm install --save-exact effect@4.1.6
npm install --save-dev --save-exact ajv@8.20.0   # tests the published JSON Schema
```

- Effect 4 is ESM-only and needs Node 22.19 or newer (raise `engines.node` with it) and TypeScript
  5.9 or newer with `strict`.
- Never install `@effect/platform`, `@effect/cli`, `@effect/rpc`, `@effect/sql`, `@effect/ai` or
  `@effect/schema`. Their npm `latest` is a v3-era 0.x package that fails to resolve beside
  effect 4. In v4 those live inside `effect` as `effect/http`, `effect/rpc` and so on.
- Three generations of names exist. v3 code (`Context.Tag`, `Effect.catchAll`, `@effect/schema`) and
  v4 beta code (`ServiceMap`, `effect/unstable/...`) both fail on 4.1.6.
- Pin exactly even for stable modules; patch and minor releases have changed stable APIs.
- Typecheck with Effect diagnostics. On TypeScript 7: `npm install -D --save-exact typescript@7.0.2
  @effect/tsgo@0.73.7`, then `npx effect-tsgo tsc -p tsconfig.json`. On 5.9:
  `npx effect-language-service diagnostics --project "$PWD/tsconfig.json" --format json --strict`
  (from `@effect/language-service@0.87.5`, which lags 4.1). It exits 0 with `Checked 0 files` unless
  the plugin is in the nearest tsconfig or `--lspconfig '{}'` is passed, so assert the count.

## Define the contract

Import from subpaths. esbuild, which wrangler uses, does not tree-shake the `effect` barrel: a Worker
that validates with Schema bundled to 101.8 KB gzip from `"effect"` and 28.6 KB from `"effect/Schema"`
(esbuild 0.28.2).

```ts
// src/settings-schema.ts
import * as Schema from "effect/Schema";

// Patterns need the `u` flag, or the JSON Schema export drops them without a warning.
export const UserId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{2,31}$/u, { expected: "a user id like \"user-42\"" }),
).pipe(Schema.brand("UserId"));
export const Hour = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 }));

export const Settings = Schema.Struct({
  version: Schema.Literal(1),
  userId: UserId,
  channel: Schema.Literals(["email", "push", "none"]),
  quietHours: Schema.optionalKey(Schema.Struct({ start: Hour, end: Hour })),
}).annotate({ identifier: "NotificationSettings" });
export type Settings = typeof Settings.Type;
```

Other checks you will need: `Schema.isUnique()`, `Schema.isGreaterThanOrEqualTo(n)`,
`Schema.NonEmptyArray(S)` and `Schema.makeFilter(fn, { expected })` for cross-field rules. The JSON
Schema export omits `makeFilter` checks and brands, so it is looser than the decoder by design.

## Decode at the boundary, with every error

```ts
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { Settings } from "./settings-schema.ts";

const decode = Schema.decodeUnknownExit(Settings);
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

export function parseSettings(input: unknown) {
  const exit = decode(input, { errors: "all", onExcessProperty: "error" });
  if (Exit.isSuccess(exit)) return { ok: true as const, value: exit.value };
  const error = exit.cause.reasons.find((r) => r._tag === "Fail")?.error;
  if (!Schema.isSchemaError(error)) throw new Error(`unexpected failure: ${String(exit.cause)}`);
  return { ok: false as const, issues: formatIssues(error.issue).issues.map((i) => ({ path: (i.path ?? []).join("."), message: i.message })) };
}
```

A bad document then yields `[{"path":"extra","message":"Expected no excess property"},
{"path":"version","message":"Expected 1"}, {"path":"quietHours.start","message":"Expected a value
between 0 and 23"}, ...]`. Collection-level filters run only after element errors are fixed, so
expect a second pass. An empty `NonEmptyArray` reports `Missing key` at index 0. Do not decode with
`make()` or an assert at a boundary: they throw a generic `Schema validation failed`.

## Publish JSON Schema

`Schema.toJsonSchemaDocument` returns a wrapper `{dialect, schema, definitions}` whose root `$ref`
points at `#/$defs/...`, which the wrapper does not hold. Loaded as-is by a validator that ignores
unknown keywords, it accepts anything. `Schema.toStandardJSONSchemaV1(S)["~standard"].jsonSchema
.input({ target: "draft-2020-12" })` is standalone but does not forbid excess properties. Assemble the
file yourself, then test it against known-bad documents before you publish it (the first test under
Property tests):

```ts
// src/settings-json-schema.ts
import * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";
import { Settings } from "./settings-schema.ts";

const doc = Schema.toJsonSchemaDocument(Settings, { onExcessProperty: "error" });
export const published = { $schema: JsonSchema.META_SCHEMA_URI_DRAFT_2020_12, ...doc.schema, $defs: doc.definitions };
```

Write `published` to a committed file (for example `schemas/settings.schema.json`) from a small
script, and fail the gate when `git diff --exit-code` shows it changed. `JsonSchema.toDocumentDraft07`
converts the document for draft-07 consumers. OpenAPI export is 3.1 only.

## Interop

- `Schema.toStandardSchemaV1(Settings)` gives a Standard Schema v1 validator. With Hono:
  `sValidator("json", Schema.toStandardSchemaV1(Settings), hook)` from `@hono/standard-validator`;
  `c.req.valid("json")` is typed. Pass a hook: the default 400 response echoes the whole request body.
- Zod 4 also implements Standard Schema, so a route or tool can accept either during a migration.

## Property tests

`effect/Arbitrary` derives generators from the schema's checks. Effect 4 removed the fast-check
bridge; raw fast-check arbitraries are rejected. `Arbitrary` and `@effect/vitest` are unstable
modules, so property results are advisory until they stabilise, and replay tokens hold only on the
same Effect version.

```ts
// test/settings.test.ts (node --test; @effect/vitest's it.prop is the Vitest route)
import assert from "node:assert/strict";
import { test } from "node:test";
import { Ajv2020 } from "ajv/dist/2020.js";
import * as Arbitrary from "effect/Arbitrary";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { published } from "../src/settings-json-schema.ts";
import { Settings } from "../src/settings-schema.ts";

const validate = new Ajv2020({ strict: true }).compile(published);

// A schema that accepts anything passes the property test below, so test the other direction too.
test("the published schema rejects known-bad documents", () => {
  const good = { version: 1, userId: "user-42", channel: "email" };
  assert.equal(validate(good), true);
  for (const bad of [{ ...good, extra: 1 }, { ...good, userId: "User 42" }, { ...good, version: 2 },
    { ...good, quietHours: { start: 0, end: 24 } }, { version: 1, channel: "email" }]) {
    assert.equal(validate(bad), false, JSON.stringify(bad));
  }
});

test("the published schema accepts every value the decoder accepts", async () => {
  const toJson = Schema.encodeSync(Schema.toCodecJson(Settings));
  const result = await Effect.runPromise(Arbitrary.checkEffect(
    Arbitrary.schema(Settings), (s) => validate(toJson(s)) === true, { runs: 300, size: 32 }));
  assert.equal(Arbitrary.formatCheckFailure(result), undefined, Arbitrary.formatCheckFailure(result));
});
```

- Set `size` at or above the largest bound in the schema. With the default size of 10, generated
  strings never pass 10 characters: a published pattern capped at 12 while the decoder allows 32
  passed 300 runs at the default size and failed at `size: 32`. Raising `runs` does not help.
- Encode with `Schema.toCodecJson(S)` before checking a JSON Schema: the export describes the JSON
  codec form (a `Date` becomes an ISO string, for example), not `encodeSync`'s output.
- Return a boolean (or a failing Effect). A thrown assertion inside `checkEffect` is a defect and is
  not shrunk. `@effect/vitest`'s `it.prop` does shrink thrown errors.
- Compare with `Schema.toEquivalence(S)`, not `deepStrictEqual`: some generated structs have a null
  prototype, and generators produce `-0`.

## Register it

```toml
[[spec]]
id = "settings-contract"
title = "Notification settings decode with every error and publish a sound JSON Schema"
kind = "data-contract"
tool = "effect-schema"
status = "checked"
artefacts = ["src/settings-schema.ts", "schemas/settings.schema.json", "test/settings.test.ts"]
covers = ["src/settings-schema.ts", "config/settings/**"]
requires = ["node", "effect"]
check = ["npm", "run", "--silent", "spec:settings"]
properties = ["rejectsKnownBadDocuments", "publishedSchemaIsSound", "jsonRoundTrip"]
notes = "Arbitrary runs 300, size 32 (the longest bound)."
```

## PR verification block

```markdown
| Entry | Tool | Command | Commit | Bounds | Result |
|---|---|---|---|---|---|
| settings-contract | effect 4.1.6 | `npm run spec:settings` | abc1234 | 300 runs, size 32, seed recorded on failure | pass; schema file unchanged |
```

## References

- There is no llms.txt (effect.website/llms.txt is 404). Read `node_modules/effect/AGENTS.md` (the same
  text as LLMS.md) and the source in `node_modules/effect/src`. Docs pages have Markdown versions,
  for example https://effect.website/docs/v4/onboarding.md. The long guides are not in the npm
  package: read SCHEMA.md and ARBITRARY.md in `packages/effect/` at tag `effect@4.1.6`
  (commit 4cc54fe) on GitHub, not on `main`.
- Upstream skills (MIT): Effect-TS/skills `effect-ts` and `effect-v3-to-v4`, read at
  155c50c911f9c99c294ef8a4461981c5bbe6453e. `effect-ts` installs `effect@latest` and edits AGENTS.md
  and CLAUDE.md: take its AGENTS.md advice, keep the exact pin, and leave agent files to sync.
- Registry and loop: `spec-first`.
