// Checks for the spec registry contract in src/spec-registry.ts.
//
//   node --experimental-strip-types --no-warnings src/spec-registry.test.ts
//
// `npm run spec:registry` runs this file, then `agentctl spec schema --check`; that is the
// check of the spec-registry-schema entry in .agent-configs/specs.toml. src/test.ts runs
// the same checks with the rest of the suite.
//
// The decoder must report every problem in one pass, each at its exact path. The committed
// JSON Schema must match the Effect Schema, and a strict validator must accept the
// registries the decoder accepts and reject the ones it rejects, apart from the gaps listed
// in registryJsonSchemaChecks.

import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parse as parseToml } from "smol-toml";
import { readText } from "./core.ts";
import { SCHEMA_FILE, decodeRegistry, parseRegistry, renderRegistryJsonSchema } from "./spec-registry.ts";
import { schemaChecks } from "./verification.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** One `[[spec]]` table in TOML, for registries written inline in a test. */
export const entry = (fields: Record<string, string | number | string[]>): string =>
  ["[[spec]]", ...Object.entries(fields).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), ""].join("\n");

export function registryDecodeChecks(): void {
  const minimal = 'version = 1\nrepo = "Some-Repo"\n';
  assert(parseRegistry(minimal).ok, "an empty registry must decode");
  const valid = minimal + entry({ id: "ledger", title: "Ledger", kind: "state-machine", tool: "quint", status: "checked", gate: "required", artefacts: ["spec/quint/ledger.qnt"], covers: ["scripts/**"], docs: ["docs/a.md", "Other-Repo:docs/b.md#c"], requires: ["node", "quint"], check: ["npm", "run", "spec:ledger"], timeout_seconds: 120, target: "AS-LEDGER-1" });
  const decoded = parseRegistry(valid);
  assert(decoded.ok && decoded.registry.spec?.[0].id === "ledger" && decoded.registry.spec[0].timeout_seconds === 120, `a valid registry did not decode: ${JSON.stringify(decoded.issues)}`);
  assert(parseRegistry(readText("integrations/verification/specs.toml.example")).ok, "the shipped template does not decode");
  assert(parseRegistry(readText(".agent-configs/specs.toml")).ok, "this repository's registry does not decode");

  // Every problem in one pass, each at its exact path: field errors in one entry do not hide
  // a duplicate id or a cross-field rule in another.
  const invalid = 'version = 2\nrepo = "bad repo"\nextra = true\n\n'
    + entry({ id: "Bad_Id", title: "x", kind: "nope", tool: "other", status: "checkd", artifacts: ["a"] })
    + entry({ id: "dup", title: "first", kind: "protocol", tool: "quint", status: "draft", gate: "required" })
    + entry({ id: "dup", title: "second", kind: "protocol", tool: "property", status: "checked", artefacts: ["/abs/path", "a/../b"], docs: ["https://example.invalid/x"], check: [], timeout_seconds: 0 });
  const result = parseRegistry(invalid);
  const issues = result.issues.map((issue) => `${issue.path}: ${issue.message}`);
  const paths = result.issues.map((issue) => issue.path);
  const expectedPaths = [
    "version", "repo", "spec[0].id", "spec[0].kind", "spec[0].status", "spec[0].notes", "spec[0].artifacts",
    "spec[1].gate", "spec[1].artefacts", "spec[1].check",
    "spec[2].id", "spec[2].artefacts[0]", "spec[2].artefacts[1]", "spec[2].docs[0]", "spec[2].check", "spec[2].timeout_seconds",
    "extra",
  ];
  assert(!result.ok && isDeepStrictEqual(paths, expectedPaths), `registry error paths drifted:\n${issues.join("\n")}`);
  for (const expected of [
    "version: Expected 1, got 2",
    'spec[0].id: Expected a kebab-case id such as action-ledger, got "Bad_Id"',
    'spec[0].notes: notes are required when tool is "other"',
    'spec[0].artifacts: unknown key "artifacts" (did you mean "artefacts"?)',
    'spec[1].gate: gate "required" needs status "checked" or "conformance", not "draft"',
    'spec[1].artefacts: at least one artefact is required unless status is "planned"',
    'spec[1].check: check is required unless status is "planned"',
    'spec[2].id: duplicate id "dup": spec[1] already uses it',
    'spec[2].artefacts[0]: "/abs/path" must be relative to the repository root',
    `spec[2].artefacts[1]: "a/../b" must not contain a '..' segment`,
    "spec[2].check: check needs at least the program to run",
    'extra: unknown key "extra"',
  ]) assert(issues.includes(expected), `missing registry error: ${expected}\ngot:\n${issues.join("\n")}`);
  const syntax = parseRegistry("version = [");
  assert(!syntax.ok && syntax.issues.length === 1 && syntax.issues[0].path === "" && syntax.issues[0].message.startsWith("TOML syntax error at line 1"), "a TOML syntax error was not one root issue");
}

export function registrySchemaChecks(): void {
  const generated = renderRegistryJsonSchema();
  assert(generated === readText(SCHEMA_FILE), `${SCHEMA_FILE} drifted from src/spec-registry.ts; run agentctl spec schema --write`);
  const schema = JSON.parse(generated);
  const entrySchema = schema.properties.spec.items;
  // Effect drops a pattern that lacks the u flag, so a missing pattern means a regression.
  assert(entrySchema.properties.id.pattern === "^[a-z0-9]+(?:-[a-z0-9]+)*$" && schema.properties.repo.pattern, "the JSON Schema lost a pattern");
  assert(schema.additionalProperties === false && entrySchema.additionalProperties === false, "the JSON Schema accepts unknown keys");
  assert(isDeepStrictEqual(entrySchema.required, ["id", "title", "kind", "tool", "status"]) && entrySchema.allOf?.length === 3, "the JSON Schema lost a required field or a cross-field rule");
  const drifted = join(tmpdir(), `agent-sync-schema-${process.pid}.json`);
  try {
    writeFileSync(drifted, generated.replace('"Spec registry"', '"Stale title"'));
    assert(schemaChecks("check", drifted).checks[0].status === "error", "schema --check accepted a stale file");
    writeFileSync(drifted, generated);
    assert(schemaChecks("check", drifted).checks[0].status === "ok", "schema --check rejected a current file");
  } finally {
    rmSync(drifted, { force: true });
  }
}

type Loose = Record<string, unknown>;

/**
 * The committed JSON Schema in a strict draft 2020-12 validator. Editors and tools in other
 * languages read this file, and Effect's export can loosen a rule without saying so, so the
 * file is tested against registries the decoder accepts and rejects.
 */
export function registryJsonSchemaChecks(): void {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  const validate = ajv.compile(JSON.parse(readText(SCHEMA_FILE)));
  const spec = (fields: Loose): Loose => ({ id: "a", title: "A", kind: "protocol", tool: "quint", status: "planned", ...fields });
  const registry = (...entries: Loose[]): Loose => ({ version: 1, repo: "Some-Repo", spec: entries });
  const checked = { status: "checked", artefacts: ["spec/a.qnt"], check: ["npm", "test"] };

  const good: Record<string, unknown> = {
    template: parseToml(readText("integrations/verification/specs.toml.example")),
    repository: parseToml(readText(".agent-configs/specs.toml")),
    empty: { version: 1, repo: "Some-Repo" },
    required: registry(spec({ ...checked, gate: "required", covers: ["src/**"], docs: ["docs/a.md", "Other-Repo:docs/b.md#c"], requires: ["node"], workdir: "app", timeout_seconds: 60, target: "AS-X-1" })),
    other: registry(spec({ tool: "other", notes: "Checked by hand." })),
  };
  const bad: Record<string, unknown> = {
    "version 2": { version: 2, repo: "Some-Repo" },
    "unknown top-level key": { version: 1, repo: "Some-Repo", extra: true },
    "repo name with a space": { version: 1, repo: "bad repo" },
    "unknown entry key": registry(spec({ artifacts: ["a"] })),
    "missing status": registry({ id: "a", title: "A", kind: "protocol", tool: "quint" }),
    "id not kebab case": registry(spec({ id: "Bad_Id" })),
    "two-line title": registry(spec({ title: "one\ntwo" })),
    "unknown kind": registry(spec({ kind: "nope" })),
    "unknown tool": registry(spec({ tool: "tla-plus" })),
    "required on a planned entry": registry(spec({ gate: "required" })),
    "required on a draft entry": registry(spec({ ...checked, status: "draft", gate: "required" })),
    "checked without a check": registry(spec({ status: "checked", artefacts: ["a"] })),
    "checked without artefacts": registry(spec({ status: "checked", check: ["x"] })),
    "checked with no artefact": registry(spec({ ...checked, artefacts: [] })),
    "an empty check": registry(spec({ ...checked, check: [] })),
    "tool other without notes": registry(spec({ tool: "other" })),
    "absolute cover": registry(spec({ covers: ["/abs"] })),
    "drive-letter cover": registry(spec({ covers: ["C:/x"] })),
    "backslash in an artefact": registry(spec({ artefacts: ["a\\b"] })),
    "parent segment in a cover": registry(spec({ covers: ["a/../b"] })),
    "absolute doc": registry(spec({ docs: ["/abs.md"] })),
    "absolute doc in another repo": registry(spec({ docs: ["Other-Repo:/abs.md"] })),
    "zero timeout": registry(spec({ timeout_seconds: 0 })),
    "fractional timeout": registry(spec({ timeout_seconds: 1.5 })),
    "target with a space": registry(spec({ target: "AS X" })),
  };
  // JSON Schema cannot say that ids are unique, and this one also accepts a drive-letter
  // doc and notes made of spaces. The decoder is the authority and rejects all three.
  const gaps: Record<string, unknown> = {
    "duplicate ids": registry(spec({}), spec({})),
    "drive-letter doc": registry(spec({ docs: ["C:/x.md"] })),
    "blank notes for tool other": registry(spec({ tool: "other", notes: "  " })),
  };
  for (const [name, value] of Object.entries(good)) {
    assert(decodeRegistry(value).ok, `the decoder rejected the good registry "${name}"`);
    assert(validate(value), `the JSON Schema rejected the good registry "${name}": ${ajv.errorsText(validate.errors)}`);
  }
  for (const [name, value] of Object.entries(bad)) {
    assert(!decodeRegistry(value).ok, `the decoder accepted the bad registry "${name}"`);
    assert(!validate(value), `the JSON Schema accepted the bad registry "${name}"`);
  }
  for (const [name, value] of Object.entries(gaps)) assert(!decodeRegistry(value).ok, `the decoder accepted "${name}", which the JSON Schema cannot reject`);
}

export function specRegistryChecks(): void {
  registryDecodeChecks();
  registrySchemaChecks();
  registryJsonSchemaChecks();
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    specRegistryChecks();
    console.log("Spec registry checks passed");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
