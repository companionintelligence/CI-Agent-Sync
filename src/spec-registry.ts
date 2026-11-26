// The spec registry contract: the format of `.agent-configs/specs.toml`.
//
// One Effect Schema is the source of truth. It decodes a registry at runtime, with every
// error reported at an exact path, and it generates
// integrations/verification/specs.schema.json for editors and for tools in other
// languages. The JSON Schema is a convenience; this decoder is the authority.
//
// Cross-field rules live on the schema as filters. Effect runs a filter only on a value
// whose fields already decoded, so the same rules also run over the raw input. That way
// one pass reports a duplicate id even while another entry still has a field error.

import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { TomlError, parse as parseToml } from "smol-toml";

export const REGISTRY_FILE = ".agent-configs/specs.toml";
export const SCHEMA_FILE = "integrations/verification/specs.schema.json";
export const SCHEMA_URL = "https://raw.githubusercontent.com/companionintelligence/CI-Agent-Sync/main/integrations/verification/specs.schema.json";
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMEOUT_SECONDS = 86_400;

export const SPEC_KINDS = ["protocol", "state-machine", "invariant", "algorithm", "data-contract", "ui-flow", "component", "agent-step", "doc-claims"] as const;
export const SPEC_TOOLS = ["quint", "lemmascript", "dafny", "effect-schema", "storybook", "bombadil", "property", "other"] as const;
export const SPEC_STATUSES = ["planned", "draft", "checked", "conformance"] as const;
export const SPEC_GATES = ["advisory", "required"] as const;

const REGISTRY_KEYS = ["version", "repo", "spec"] as const;
const ENTRY_KEYS = [
  "id", "title", "kind", "tool", "status", "gate", "artefacts", "covers", "docs", "requires", "check",
  "workdir", "timeout_seconds", "properties", "conformance", "target", "owner", "notes",
] as const;

// Every pattern carries the `u` flag: Effect exports a pattern to JSON Schema only then.
const KEBAB_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const REPO_NAME = /^[A-Za-z0-9._-]+$/u;
const TARGET_ID = /^[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*$/u;
const ONE_LINE = /^[^\r\n]+$/u;
const CROSS_REPO_DOC = /^([A-Za-z0-9][A-Za-z0-9._-]*):(.+)$/u;

/** Why a repo-relative path is unusable, or undefined when it is fine. */
export function repoPathProblem(value: string): string | undefined {
  if (/^\//u.test(value) || /^[A-Za-z]:/u.test(value)) return "must be relative to the repository root";
  if (value.includes("\\")) return "must use forward slashes";
  if (value.split("/").includes("..")) return "must not contain a '..' segment";
  return undefined;
}

/** Why a `docs` reference is unusable: a repo path or `<Repo>:<path>[#anchor]`. */
export function docRefProblem(value: string): string | undefined {
  const crossRepo = CROSS_REPO_DOC.exec(value);
  // A one-letter prefix followed by a slash is a Windows drive, not a repository.
  const isDrive = crossRepo !== null && crossRepo[1].length === 1 && /^[\\/]/u.test(crossRepo[2]);
  const reference = crossRepo !== null && !isDrive ? crossRepo[2] : value;
  const path = reference.split("#", 1)[0];
  if (path.length === 0) return "needs a path before any '#anchor'";
  const problem = repoPathProblem(path);
  return problem === undefined ? undefined : `${problem} (use a repo path or <Repo>:<path>[#anchor])`;
}

const notAbsolute = { not: { pattern: "^(?:/|[A-Za-z]:)" } };
const noBackslash = { not: { pattern: "\\\\" } };
const noParentSegment = { not: { pattern: "(?:^|/)\\.\\.(?:/|$)" } };

const withValue = (problem: (value: string) => string | undefined) => (value: string) => {
  const found = problem(value);
  return found === undefined ? undefined : `${JSON.stringify(value)} ${found}`;
};

// Descriptions go on the base schema, before the checks, so the JSON Schema shows them on
// the property itself.
const KebabId = Schema.String.check(Schema.isPattern(KEBAB_ID, { expected: "a kebab-case id such as action-ledger" }));
const OneLine = Schema.String.check(Schema.isPattern(ONE_LINE, { expected: "one non-empty line" }));
const text = (description: string) => Schema.String.annotate({ description }).check(Schema.isMinLength(1));
const repoPath = (description?: string) =>
  Schema.String.annotate(description === undefined ? {} : { description }).check(
    Schema.isMinLength(1),
    Schema.makeFilter(withValue(repoPathProblem), {
      expected: "a repo-relative path",
      toJsonSchema: () => ({ allOf: [notAbsolute, noBackslash, noParentSegment] }),
    }),
  );
const DocRef = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter(withValue(docRefProblem), {
    expected: "a repo-relative path or <Repo>:<path>[#anchor]",
    toJsonSchema: () => [{ allOf: [{ not: { pattern: "^(?:[A-Za-z0-9][A-Za-z0-9._-]+:)?/" } }, noBackslash] }, true],
  }),
);
const Argv = Schema.Array(Schema.NonEmptyString).check(Schema.isMinLength(1, { message: "check needs at least the program to run" }));
const Timeout = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_TIMEOUT_SECONDS }));

export type RuleIssue = { readonly path: ReadonlyArray<string | number>; readonly message: string };
type Loose = Record<string, unknown>;

const isLoose = (value: unknown): value is Loose => typeof value === "object" && value !== null && !Array.isArray(value);
const isOneOf = <T extends string>(values: ReadonlyArray<T>, value: unknown): value is T => typeof value === "string" && (values as ReadonlyArray<string>).includes(value);

/**
 * The per-entry rules of section 3.1 that a field schema cannot express. Each rule reads
 * only fields that are themselves valid, so a typo in `status` is reported once, by the
 * field schema, and not again here.
 */
export function entryRuleIssues(entry: Loose): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const status = isOneOf(SPEC_STATUSES, entry.status) ? entry.status : undefined;
  if (entry.gate === "required" && status !== undefined && status !== "checked" && status !== "conformance") {
    issues.push({ path: ["gate"], message: `gate "required" needs status "checked" or "conformance", not "${status}"` });
  }
  if (status !== undefined && status !== "planned") {
    if (!Array.isArray(entry.artefacts) || entry.artefacts.length === 0) {
      issues.push({ path: ["artefacts"], message: `at least one artefact is required unless status is "planned"` });
    }
    if (entry.check === undefined) {
      issues.push({ path: ["check"], message: `check is required unless status is "planned"` });
    }
  }
  if (entry.tool === "other" && (typeof entry.notes !== "string" || entry.notes.trim() === "")) {
    issues.push({ path: ["notes"], message: `notes are required when tool is "other"` });
  }
  return issues;
}

/** Ids must be unique within the registry. Entries without a string id are skipped here. */
export function duplicateIdIssues(entries: ReadonlyArray<unknown>): RuleIssue[] {
  const seen = new Map<string, number>();
  const issues: RuleIssue[] = [];
  entries.forEach((entry, index) => {
    if (!isLoose(entry) || typeof entry.id !== "string") return;
    const first = seen.get(entry.id);
    if (first === undefined) seen.set(entry.id, index);
    else issues.push({ path: [index, "id"], message: `duplicate id "${entry.id}": spec[${first}] already uses it` });
  });
  return issues;
}

const toFilterIssues = (issues: RuleIssue[]) => issues.map((issue) => ({ path: issue.path, issue: issue.message }));

const SpecEntrySchema = Schema.Struct({
  id: KebabId.annotate({ description: "Kebab case, unique in the repository." }),
  title: OneLine.annotate({ description: "One line." }),
  kind: Schema.Literals(SPEC_KINDS).annotate({ description: "What the spec describes." }),
  tool: Schema.Literals(SPEC_TOOLS).annotate({ description: "The tool that checks it. \"other\" needs notes." }),
  status: Schema.Literals(SPEC_STATUSES).annotate({
    description: "planned: a target with no artefact yet. draft: an artefact whose check may fail; never gates. checked: the check passes on the default branch. conformance: it passes and the code is tied to it.",
  }),
  gate: Schema.optionalKey(Schema.Literals(SPEC_GATES).annotate({ description: "advisory (the default) or required. required needs status checked or conformance." })),
  artefacts: Schema.optionalKey(Schema.Array(repoPath()).annotate({ description: "Repo-relative paths. They must exist unless the entry is planned." })),
  covers: Schema.optionalKey(Schema.Array(repoPath()).annotate({ description: "Repo-relative paths or globs (*, **, ?) of the code the spec constrains." })),
  docs: Schema.optionalKey(Schema.Array(DocRef).annotate({ description: "Documents the spec backs: a repo path, or <Repo>:<path>[#anchor]." })),
  requires: Schema.optionalKey(Schema.Array(KebabId).annotate({ description: "Toolchain ids from CI-Agent-Sync's integrations/verification/toolchains.yaml." })),
  check: Schema.optionalKey(Argv.annotate({ description: "An argv array, run without a shell from the repo root or workdir. Required unless planned." })),
  workdir: Schema.optionalKey(repoPath("Directory to run the check in, relative to the repository root.")),
  timeout_seconds: Schema.optionalKey(Timeout.annotate({ description: `Seconds before the check is stopped. Default ${DEFAULT_TIMEOUT_SECONDS}.` })),
  properties: Schema.optionalKey(Schema.Array(text("A property name.")).annotate({ description: "Named properties, invariants or lemmas the check covers." })),
  conformance: Schema.optionalKey(text("How the code is tied to the spec: trace replay, a differential test, or verified code that ships.")),
  target: Schema.optionalKey(
    Schema.String.annotate({ description: "A target id from the planning catalogue, such as AS-LEDGER-1." }).check(Schema.isPattern(TARGET_ID, { expected: "a target id such as AS-LEDGER-1" })),
  ),
  owner: Schema.optionalKey(text("Who reviews changes to this spec.")),
  notes: Schema.optionalKey(text("Assumptions, limits, or the reason for tool other.")),
}).check(
  Schema.makeFilter((entry) => toFilterIssues(entryRuleIssues(entry as Loose)), {
    expected: "an entry that follows the cross-field rules",
    toJsonSchema: () => ({
      allOf: [
        { if: { properties: { gate: { const: "required" } }, required: ["gate"] }, then: { properties: { status: { enum: ["checked", "conformance"] } } } },
        // Each branch declares the properties it requires, so strict validators accept it.
        { if: { properties: { status: { const: "planned" } } }, else: { required: ["artefacts", "check"], properties: { artefacts: { type: "array", minItems: 1 }, check: { type: "array", minItems: 1 } } } },
        { if: { properties: { tool: { const: "other" } }, required: ["tool"] }, then: { required: ["notes"], properties: { notes: { type: "string", minLength: 1 } } } },
      ],
    }),
  }),
);

export const SpecRegistrySchema = Schema.Struct({
  version: Schema.Literal(1).annotate({ description: "Format version. Always 1." }),
  repo: Schema.String.check(Schema.isPattern(REPO_NAME, { expected: "a GitHub repository name" })).annotate({ description: "The GitHub repository name." }),
  spec: Schema.optionalKey(
    Schema.Array(SpecEntrySchema)
      .check(Schema.makeFilter((entries) => toFilterIssues(duplicateIdIssues(entries)), { expected: "unique ids", toJsonSchema: () => [{}, true] }))
      .annotate({ description: "Zero or more entries. A registry with none is valid." }),
  ),
}).annotate({
  title: "Spec registry",
  description: "The formal and executable specifications a repository keeps, at .agent-configs/specs.toml. Format owned by CI-Agent-Sync.",
});

export type SpecRegistry = typeof SpecRegistrySchema.Type;
export type SpecEntry = NonNullable<SpecRegistry["spec"]>[number];
export type SpecTool = (typeof SPEC_TOOLS)[number];
export type SpecStatus = (typeof SPEC_STATUSES)[number];

/** One problem with a registry: a path such as `spec[2].gate` and a message. */
export type RegistryIssue = { readonly path: string; readonly message: string };
export type DecodeResult =
  | { readonly ok: true; readonly registry: SpecRegistry; readonly issues: readonly [] }
  | { readonly ok: false; readonly registry?: undefined; readonly issues: ReadonlyArray<RegistryIssue> };

export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out;
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

function keysAt(path: ReadonlyArray<PropertyKey>): ReadonlyArray<string> {
  return path.length === 1 ? REGISTRY_KEYS : path.length === 3 && path[0] === "spec" ? ENTRY_KEYS : [];
}

function unknownKeyMessage(path: ReadonlyArray<PropertyKey>): string {
  const key = String(path.at(-1));
  const known = keysAt(path);
  const nearest = known
    .map((candidate) => ({ candidate, distance: editDistance(key.toLowerCase(), candidate) }))
    .filter((item) => item.distance <= 2)
    .sort((left, right) => left.distance - right.distance)[0];
  return nearest ? `unknown key "${key}" (did you mean "${nearest.candidate}"?)` : `unknown key "${key}"`;
}

const UNKNOWN_KEY = "\u0000unknown-key";
const MISSING_KEY = "\u0000missing-key";
const formatter = SchemaIssue.makeFormatterStandardSchemaV1({
  leafHook: (issue) => issue._tag === "UnexpectedKey" ? UNKNOWN_KEY : issue._tag === "MissingKey" ? MISSING_KEY : SchemaIssue.defaultLeafHook(issue),
});

const FIELD_ORDER: ReadonlyArray<string> = [...REGISTRY_KEYS, ...ENTRY_KEYS];

function comparePaths(left: ReadonlyArray<PropertyKey>, right: ReadonlyArray<PropertyKey>): number {
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return a - b;
    const rank = (value: PropertyKey) => {
      const found = FIELD_ORDER.indexOf(String(value));
      return found === -1 ? FIELD_ORDER.length : found;
    };
    return rank(a) - rank(b) || String(a).localeCompare(String(b));
  }
  return left.length - right.length;
}

function rawRuleIssues(input: unknown): RuleIssue[] {
  if (!isLoose(input) || !Array.isArray(input.spec)) return [];
  const entries = input.spec as unknown[];
  const perEntry = entries.flatMap((entry, index) => (isLoose(entry) ? entryRuleIssues(entry).map((issue) => ({ path: ["spec", index, ...issue.path], message: issue.message })) : []));
  const duplicates = duplicateIdIssues(entries).map((issue) => ({ path: ["spec", ...issue.path], message: issue.message }));
  return [...perEntry, ...duplicates];
}

/** Decode an already-parsed registry. Every problem is reported, each at an exact path. */
export function decodeRegistry(input: unknown): DecodeResult {
  const result = Schema.decodeUnknownResult(SpecRegistrySchema, { errors: "all", onExcessProperty: "error", reportInput: true })(input);
  if (Result.isSuccess(result)) return { ok: true, registry: result.success, issues: [] };
  const flattened = formatter(result.failure.issue).issues.map((issue) => {
    const path = (issue.path ?? []).map((segment) => (typeof segment === "object" && segment !== null && "key" in segment ? segment.key : segment)) as PropertyKey[];
    const message = issue.message === UNKNOWN_KEY ? unknownKeyMessage(path) : issue.message === MISSING_KEY ? `missing required key "${String(path.at(-1))}"` : issue.message;
    return { path, message };
  });
  const seen = new Set(flattened.map((issue) => `${formatPath(issue.path)}\u0000${issue.message}`));
  for (const issue of rawRuleIssues(input)) {
    const key = `${formatPath(issue.path)}\u0000${issue.message}`;
    if (!seen.has(key)) {
      seen.add(key);
      flattened.push({ path: [...issue.path], message: issue.message });
    }
  }
  flattened.sort((left, right) => comparePaths(left.path, right.path));
  return { ok: false, issues: flattened.map((issue) => ({ path: formatPath(issue.path), message: issue.message })) };
}

/** Parse TOML text and decode it as a registry. A syntax error is one issue at the root. */
export function parseRegistry(text: string): DecodeResult {
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (error) {
    if (error instanceof TomlError) {
      const firstLine = error.message.split("\n", 1)[0];
      return { ok: false, issues: [{ path: "", message: `TOML syntax error at line ${error.line}, column ${error.column}: ${firstLine}` }] };
    }
    return { ok: false, issues: [{ path: "", message: `could not parse TOML: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  return decodeRegistry(parsed);
}

/** The JSON Schema document generated from SpecRegistrySchema (draft 2020-12, standalone). */
export function registryJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(SpecRegistrySchema, { onExcessProperty: "error" });
  const definitions = document.definitions as Record<string, unknown>;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SCHEMA_URL,
    ...(document.schema as Record<string, unknown>),
    ...(Object.keys(definitions).length > 0 ? { $defs: definitions } : {}),
  };
}

/** The exact text of integrations/verification/specs.schema.json. */
export function renderRegistryJsonSchema(): string {
  return `${JSON.stringify(registryJsonSchema(), null, 2)}\n`;
}

export function entryGate(entry: SpecEntry): "advisory" | "required" {
  return entry.gate ?? "advisory";
}
