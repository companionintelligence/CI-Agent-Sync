import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { ROOT, fileExists, readText, redactSecrets, runCommand, runCommandAsync, safeDetail } from "./core.ts";
import { ACTION_TAKEN, ItfError, NONDET_PICKS, decodeItfValue, itfAction, itfPicks, parseItfTrace, type ItfValue } from "./itf.ts";
import { classifyNanoKvmMcp, classifyProduct, envName, loadKvmTargets, mcpSnippet, nanoKvmKeyEnv, rowStatus } from "./kvm.ts";
import { summarizeTailscaleStatus } from "./platform.ts";
import { SCHEMA_FILE, SPEC_GATES, SPEC_KINDS, SPEC_STATUSES, SPEC_TOOLS, parseRegistry, renderRegistryJsonSchema } from "./spec-registry.ts";
import { POLICY_FILE, TOOLCHAINS_FILE, displayPath, hideHome, probeToolchain, readProbeVersion, type Toolchain } from "./toolchains.ts";
import { verificationChecks } from "./validate.ts";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  applyBlock,
  blockChecks,
  checkEntries,
  entriesTouchedBy,
  initRegistry,
  matchesPattern,
  parseSpecArgs,
  renderSpecBlock,
  resolveInsideRepo,
  schemaChecks,
} from "./verification.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function kvmChecks(): void {
  // MCP classification follows the HTTP status of /api/mcp on NanoKVM firmware.
  assert(classifyNanoKvmMcp(401) === "enabled_auth_required", "401 from /api/mcp must mean MCP is on and keyed");
  assert(classifyNanoKvmMcp(200) === "enabled_unauthenticated", "200 without a key must be flagged, not treated as safe");
  assert(classifyNanoKvmMcp(403) === "disabled_or_blocked", "403 must not look like an enabled MCP");
  assert(classifyNanoKvmMcp(404) === "not_in_firmware", "404 must point at firmware, not at a keyed MCP");
  assert(classifyNanoKvmMcp(null) === "not_reachable" && classifyNanoKvmMcp(500) === "unexpected", "unknown answers must not be guessed");
  // Product detection: the NanoKVM title wins, PiKVM is recognised by its login redirect or API auth.
  assert(classifyProduct({ rootStatus: 200, rootTitle: "NanoKVM" }) === "nanokvm", "NanoKVM title not recognised");
  assert(classifyProduct({ rootStatus: 302, redirectsToLogin: true }) === "pikvm", "PiKVM login redirect not recognised");
  assert(classifyProduct({ rootStatus: 200, apiInfoStatus: 401 }) === "pikvm", "PiKVM API 401 not recognised");
  assert(classifyProduct({ rootStatus: null }) === "unreachable", "a silent device must not be reported as a product");
  // Status: excluded or unreachable devices are never reported as ready.
  assert(rowStatus({ enabled: true, product: "nanokvm", mcp: "enabled_auth_required", model: "nanokvm" }).status === "ok", "keyed NanoKVM MCP should be ok");
  assert(rowStatus({ enabled: true, product: "nanokvm", mcp: "enabled_unauthenticated", model: "nanokvm" }).status === "warn", "open MCP must warn");
  assert(rowStatus({ enabled: true, product: "nanokvm", mcp: "disabled_or_blocked", model: "nanokvm" }).status === "warn", "disabled MCP must warn");
  assert(rowStatus({ enabled: false, product: "unreachable", mcp: "not_reachable", model: "nanokvm" }).status === "skipped", "disabled targets must be skipped");
  assert(envName("core-14-kvm") === "CORE_14_KVM" && nanoKvmKeyEnv("core-14-kvm") === "NANOKVM_CORE_14_KVM_API_KEY", "env naming drifted");

  // Every probed NanoKVM that may be driven has a 1Password env line, and nothing excluded does.
  const targets = loadKvmTargets().targets;
  const envFile = readText("integrations/kvm/op.env.example");
  for (const [name, spec] of Object.entries(targets)) {
    assert(["nanokvm", "pikvm"].includes(spec.model), `${name} has an unknown model`);
    if (spec.model === "nanokvm" && !spec.excluded_from_mcp) assert(envFile.includes(`${nanoKvmKeyEnv(name)}=op://Agent Configs/agent-configs-kvm-${name}/credential`), `${name} has no 1Password key line`);
    if (spec.excluded_from_mcp) assert(!envFile.includes(nanoKvmKeyEnv(name)), `${name} is excluded from MCP but has a key line`);
  }
  const snippet = mcpSnippet("core-14-kvm", targets["core-14-kvm"], "https");
  assert(snippet.includes("${NANOKVM_CORE_14_KVM_API_KEY}") && snippet.includes("https://core-14-kvm/api/mcp"), "MCP snippet must use an env placeholder and the device endpoint");
  assert(!/Bearer\s+[A-Za-z0-9]{12,}/.test(snippet), "MCP snippet must never contain a literal key");

  // Operator decisions from the fleet roster stay enforced in the sync targets.
  const fleetTargets = readText("integrations/fleet/targets.yaml");
  assert(!/^\s{2}ci-core:/m.test(fleetTargets), "removed fleet target must stay removed");
}

function itfChecks(): void {
  // A hand-written trace shaped like `quint run --mbt --out-itf` output, vars listed twice included.
  const text = readText("src/fixtures/itf/traffic-light.itf.json");
  const trace = parseItfTrace(text);
  assert(isDeepStrictEqual(trace.vars, ["light", "ticks", "seen", "visits", "last", ACTION_TAKEN, NONDET_PICKS]), "ITF vars were not deduplicated in order");
  assert(trace.states.length === 3 && trace.meta.format === "ITF", "ITF states or #meta were lost");
  const [first, second, third] = trace.states;
  assert(second.ticks === 2n && third.ticks === 9007199254740993n, "#bigint did not decode to an exact bigint");
  assert(third.seen instanceof Set && isDeepStrictEqual(third.seen, new Set(["Green", "Red", "Yellow"])), "#set did not decode to a Set");
  assert(third.visits instanceof Map && (third.visits as Map<ItfValue, ItfValue>).get("Green") === 1n && isDeepStrictEqual(first.visits, new Map()), "#map did not decode to a Map");
  assert(isDeepStrictEqual(second.last, [1n, "step"]), "#tup did not decode to an array");
  assert(isDeepStrictEqual(second.light, { tag: "Green", value: [] }), "a variant did not stay a { tag, value } record");
  assert(itfAction(first) === "init" && itfAction(second) === "step", "itfAction did not read mbt::actionTaken");
  assert(isDeepStrictEqual(itfPicks(second), { next: "Green", wait: 2n }), "itfPicks did not unwrap Some");
  assert(isDeepStrictEqual(itfPicks(third), { next: "Yellow", wait: undefined }), "itfPicks did not turn None into undefined");
  assert(isDeepStrictEqual(parseItfTrace(JSON.parse(text)), trace), "a parsed object and its JSON text decode differently");
  const rejects = (input: unknown, fragment: string): boolean => {
    try {
      decodeItfValue(input);
      return false;
    } catch (error) {
      return error instanceof ItfError && error.message.includes(fragment);
    }
  };
  assert(rejects({ "#unserializable": "fn" }, "unserializable"), "#unserializable was not an error");
  assert(rejects({ a: { "#set": [1, { "#unserializable": "x" }] } }, "$.a.#set[1]"), "an ITF error lost its path");
  assert(rejects({ "#bigint": "12x" }, "#bigint"), "a malformed #bigint was accepted");
  assert(rejects({ "#weird": 1 }, "unknown ITF key"), "an unknown # key was accepted");
  assert(rejects(1.5, "not an integer"), "a fraction was accepted as an ITF value");
  assert(rejects(null, "null"), "null was accepted as an ITF value");
  let missingVar = false;
  try {
    parseItfTrace({ vars: ["x"], states: [{}] });
  } catch (error) {
    missingVar = error instanceof ItfError && error.message.includes("missing variable x");
  }
  assert(missingVar, "a state without a declared variable was accepted");
}

// A throwaway directory for a test, removed afterwards whatever happens.
async function withTempDir(prefix: string, run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), `agent-sync-${prefix}-`));
  try {
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeRepoFile(repo: string, path: string, text: string): void {
  mkdirSync(join(repo, path, ".."), { recursive: true });
  writeFileSync(join(repo, path), text);
}

const entry = (fields: Record<string, string | number | string[]>): string =>
  ["[[spec]]", ...Object.entries(fields).map(([key, value]) => `${key} = ${JSON.stringify(value)}`), ""].join("\n");

function registryDecodeChecks(): void {
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

function registrySchemaChecks(): void {
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

const javaPattern = 'version "(\\d+(?:\\.\\d+)*)';
const fakeToolchain = (fields: Partial<Toolchain> & Pick<Toolchain, "id">): Toolchain => ({ name: fields.id, kind: "tool", ring: "trial", provides: [], prerequisites: [], environment: [], ...fields });
const nodeToolchain = fakeToolchain({ id: "node", kind: "runtime", ring: "adopt", minimum: "22.6.0", probe: { kind: "command", commands: [process.execPath], args: ["--version"], stream: "stdout", pattern: "^v(\\d+\\.\\d+\\.\\d+)" } });
const missingToolchain = fakeToolchain({ id: "missing-tool", version: "1.0.0", probe: { kind: "command", commands: ["agent-sync-no-such-tool"], args: ["--version"], stream: "both", pattern: "(\\d+\\.\\d+\\.\\d+)" } });

async function probeChecks(): Promise<void> {
  const stderrOnly = { stdout: "", stderr: 'openjdk version "21.0.13" 2025-10-21\nOpenJDK Runtime Environment (build 21.0.13+11)\n' };
  assert(readProbeVersion(stderrOnly, "stderr", javaPattern) === "21.0.13", "a version on stderr was not read");
  assert(readProbeVersion(stderrOnly, "stdout", javaPattern) === undefined, "stdout-only probing read stderr");
  assert(readProbeVersion(stderrOnly, "both", javaPattern) === "21.0.13", "a both-stream probe missed stderr");
  const java = (minimum: string, stream: "stdout" | "stderr") => fakeToolchain({ id: "java", kind: "runtime", minimum, probe: { kind: "command", commands: [process.execPath], args: ["-e", "process.stderr.write('openjdk version \"21.0.13\" 2025-10-21\\n')"], stream, pattern: javaPattern } });
  const ok = await probeToolchain(java("21", "stderr"), { repo: ROOT });
  assert(ok.status === "ok" && ok.usable && ok.version === "21.0.13", `a stderr probe failed: ${ok.detail}`);
  const old = await probeToolchain(java("22", "stderr"), { repo: ROOT });
  assert(old.status === "warn" && old.usable && old.detail.includes("needs 22 or later"), `a version below the minimum was not a warning: ${old.detail}`);
  const wrongStream = await probeToolchain(java("21", "stdout"), { repo: ROOT });
  assert(wrongStream.status === "warn" && !wrongStream.usable, "a probe of the wrong stream claimed a version");
  const missing = await probeToolchain(missingToolchain, { repo: ROOT });
  assert(missing.status === "not-installed" && !missing.usable, "a missing command was not reported as not installed");
  const hung = await probeToolchain(fakeToolchain({ id: "slow", version: "1.0.0", probe: { kind: "command", commands: [process.execPath], args: ["-e", "setTimeout(() => {}, 5000)"], stream: "stdout", pattern: "(\\d+)" } }), { repo: ROOT, timeoutMs: 200 });
  assert(hung.status === "warn" && !hung.usable && hung.detail.includes("timed out"), "a hung probe did not time out");
  assert(displayPath("/home/someone/.local/bin/node", "/home/someone") === "~/.local/bin/node" && displayPath("/home/someoneelse/x", "/home/someone") === "/home/someoneelse/x", "a report path kept the home directory");
  assert(hideHome("at /home/someone/repo/x.ts:1 and /home/someone/y", "/home/someone") === "at ~/repo/x.ts:1 and ~/y", "check output kept the home directory");
  const held = await probeToolchain(fakeToolchain({ id: "held", ring: "hold", version: "0.0.1" }), { repo: ROOT });
  assert(held.status === "info" && !held.usable, "a held tool was probed");
  await withTempDir("probe", async (repo) => {
    writeRepoFile(repo, "node_modules/fake-lib/package.json", JSON.stringify({ name: "fake-lib", version: "1.2.3" }));
    const pinned = await probeToolchain(fakeToolchain({ id: "fake-lib", kind: "library", version: "1.2.3", probe: { kind: "package", package: "fake-lib" } }), { repo });
    const other = await probeToolchain(fakeToolchain({ id: "fake-lib", kind: "library", version: "1.2.4", probe: { kind: "package", package: "fake-lib" } }), { repo });
    assert(pinned.status === "ok" && other.status === "warn" && other.usable, "a package probe misjudged the pinned version");
  });
}

function storeVerificationChecks(): void {
  const vocabulary = { tools: SPEC_TOOLS, kinds: SPEC_KINDS, gates: SPEC_GATES, statuses: SPEC_STATUSES };
  const toolchains = parseYaml(readText(TOOLCHAINS_FILE));
  const policy = parseYaml(readText(POLICY_FILE));
  const registries = [{ id: "example", file: "x", text: readText("integrations/verification/specs.toml.example") }];
  const clean = verificationChecks({ toolchains, policy, registries, decode: parseRegistry, vocabulary });
  assert(clean.every((check) => check.status === "ok"), `verification store checks failed: ${JSON.stringify(clean.filter((check) => check.status !== "ok"))}`);
  assert(clean.some((check) => check.id === "verification.toolchain.vibelang") && toolchains.toolchains.find((item: any) => item.id === "vibelang").ring === "hold", "vibelang must stay listed on hold");
  const duplicated = structuredClone(toolchains);
  duplicated.toolchains.push(structuredClone(duplicated.toolchains.find((item: any) => item.id === "quint")));
  delete duplicated.toolchains.find((item: any) => item.id === "bombadil").not_for;
  const broken = structuredClone(policy);
  broken.change_classes[0].tools.push("tla-plus");
  const failing = verificationChecks({ toolchains: duplicated, policy: broken, registries: [{ id: "bad", file: "x", text: 'version = 1\nrepo = "x"\n' + entry({ id: "a", title: "A", kind: "protocol", tool: "quint", status: "planned", requires: ["no-such-toolchain"] }) }], decode: parseRegistry, vocabulary });
  const errors = failing.filter((check) => check.status === "error").map((check) => `${check.id}: ${check.detail}`);
  assert(errors.some((error) => error.startsWith("verification.toolchain.quint: duplicate id")), `a duplicate toolchain id was not caught: ${errors.join("; ")}`);
  assert(errors.some((error) => error.startsWith("verification.toolchain.bombadil: not_for")), `a tool without not_for was not caught: ${errors.join("; ")}`);
  assert(errors.some((error) => error.includes('unknown or held tool "tla-plus"')), "a policy naming an unknown tool was not caught");
  assert(errors.some((error) => error.includes('"no-such-toolchain" is not a toolchain id')), "a registry requiring an unknown toolchain was not caught");
}

function argumentAndPathChecks(): void {
  const parsed = parseSpecArgs(["--json", "report.txt", "--repo=a=b", "--only", "x,y", "--only", "z"]);
  assert(parsed.flags.has("--json") && isDeepStrictEqual(parsed.positional, ["report.txt"]), "a boolean flag consumed the next token");
  assert(isDeepStrictEqual(parsed.values.get("--repo"), ["a=b"]) && isDeepStrictEqual(parsed.values.get("--only"), ["x,y", "z"]), "--key=value or a repeated option was parsed wrongly");
  assert(parseSpecArgs(["--only"]).problems.length === 1 && parseSpecArgs(["--bogus"]).problems.length === 1 && parseSpecArgs(["--json=1"]).problems.length === 1, "bad options were accepted");
  assert(matchesPattern("src/a/b.ts", "src/**") && matchesPattern("src/a.ts", "src/*.ts") && !matchesPattern("src/a/b.ts", "src/*.ts"), "* or ** matched wrongly");
  assert(matchesPattern("spec/quint/a.qnt", "**/*.qnt") && matchesPattern("a.qnt", "**/*.qnt") && matchesPattern("docs/x.md", "docs") && !matchesPattern("docsx/y.md", "docs"), "globs or directory prefixes matched wrongly");
  assert(matchesPattern("scripts/sync.rb", "scripts/sync.rb") && !matchesPattern("scripts/sync.rbx", "scripts/sync.rb") && matchesPattern("a1.ts", "a?.ts"), "exact paths or ? matched wrongly");
}

async function checkRunnerChecks(): Promise<void> {
  await withTempDir("check", async (repo) => {
    writeRepoFile(repo, "spec/a.txt", "x\n");
    const node = process.execPath;
    const common = { kind: "invariant", tool: "property", artefacts: ["spec/a.txt"] };
    writeRepoFile(repo, ".agent-configs/specs.toml", 'version = 1\nrepo = "check-test"\n\n'
      + entry({ id: "passes", title: "Passes", ...common, status: "checked", gate: "required", covers: ["src/**"], requires: ["node"], check: [node, "-e", "console.log('fine')"] })
      + entry({ id: "fails-advisory", title: "Fails", ...common, status: "checked", check: [node, "-e", "console.error('boom'); process.exit(3)"] })
      + entry({ id: "fails-required", title: "Fails", ...common, status: "conformance", gate: "required", check: [node, "-e", "process.exit(1)"] })
      + entry({ id: "times-out", title: "Hangs", ...common, status: "checked", gate: "required", timeout_seconds: 1, check: [node, "-e", "setTimeout(() => {}, 20000)"] })
      + entry({ id: "missing-required", title: "Missing", ...common, status: "checked", gate: "required", requires: ["missing-tool"], check: ["agent-sync-no-such-tool"] })
      + entry({ id: "missing-advisory", title: "Missing", ...common, status: "draft", requires: ["missing-tool"], check: ["agent-sync-no-such-tool"] })
      + entry({ id: "unknown-toolchain", title: "Unknown", ...common, status: "checked", requires: ["no-such-toolchain"], check: [node, "-e", "0"] })
      + entry({ id: "later", title: "Later", kind: "protocol", tool: "quint", status: "planned" }));
    const started = Date.now();
    const { checks } = await checkEntries({ repo, toolchains: [nodeToolchain, missingToolchain] });
    const byId = new Map(checks.map((check) => [check.id, check]));
    const status = (id: string) => byId.get(`spec.${id}`)?.status;
    assert(status("passes") === "ok", `a passing check was not ok: ${byId.get("spec.passes")?.detail}`);
    assert(status("fails-advisory") === "warn" && String(byId.get("spec.fails-advisory")?.detail).includes("boom") && byId.get("spec.fails-advisory")?.exit_code === 3, "an advisory failure was not a warning with its output");
    assert(status("fails-required") === "error", "a required failure was not an error");
    assert(status("times-out") === "error" && String(byId.get("spec.times-out")?.detail).includes("timed out after 1 s") && Date.now() - started < 10_000, "a hung check was not stopped by its timeout");
    assert(status("missing-required") === "error" && String(byId.get("spec.missing-required")?.detail).includes("missing toolchain missing-tool"), "a missing toolchain was not an error for a required entry");
    assert(status("missing-advisory") === "warn", "a missing toolchain was not a warning for an advisory entry");
    assert(status("unknown-toolchain") === "error", "an unknown toolchain was not an error");
    assert(status("later") === "skipped", "a planned entry was not reported as skipped");
    assert(checks.filter((check) => check.status === "ok").every((check) => check.id === "spec.passes"), "a skipped or unrun entry was reported as ok");

    const only = await checkEntries({ repo, only: ["passes", "nope"], toolchains: [nodeToolchain, missingToolchain] });
    assert(only.checks.some((check) => check.id === "spec.passes") && !only.checks.some((check) => check.id === "spec.later") && only.checks.some((check) => check.id === "selection.only.nope" && check.status === "error"), "--only selected wrongly");
    const tools = await checkEntries({ repo, tools: ["quint"], toolchains: [nodeToolchain, missingToolchain] });
    assert(tools.checks.length === 1 && tools.checks[0].id === "spec.later", "--tool selected wrongly");

    // --changed-from selects the entries whose covers or artefacts the branch touched.
    const git = (...args: string[]) => runCommand("git", ["-C", repo, "-c", "user.email=test@example.invalid", "-c", "user.name=agent-sync test", ...args], { timeoutMs: 30_000 });
    assert(git("init", "-q", "-b", "main").exitCode === 0 && git("add", "-A").exitCode === 0 && git("commit", "-qm", "base").exitCode === 0, "could not create a test git repository");
    writeRepoFile(repo, "src/x.ts", "export {};\n");
    assert(git("checkout", "-qb", "feature").exitCode === 0 && git("add", "-A").exitCode === 0 && git("commit", "-qm", "change").exitCode === 0, "could not commit on a test branch");
    const changed = await checkEntries({ repo, changedFrom: "main", toolchains: [nodeToolchain, missingToolchain] });
    assert(isDeepStrictEqual(changed.selection.selected, ["passes"]) && changed.checks.length === 1 && changed.checks[0].status === "ok", `--changed-from selected wrongly: ${JSON.stringify(changed.selection)}`);
    const badRef = await checkEntries({ repo, changedFrom: "--output=x", toolchains: [nodeToolchain] });
    assert(badRef.checks.some((check) => check.id === "selection.changed-from" && check.status === "error"), "an option passed as a ref was not refused");
    const touched = entriesTouchedBy([{ id: "a", title: "A", kind: "protocol", tool: "quint", status: "planned", covers: ["lib/**"] }], ["lib/x.ts"]);
    assert(touched.length === 1, "entriesTouchedBy missed a covered file");
  });
}

async function blockAndInitChecks(): Promise<void> {
  const registryText = 'version = 1\nrepo = "block-test"\n\n'
    + entry({ id: "schema", title: "Schema", kind: "data-contract", tool: "effect-schema", status: "checked", gate: "required", artefacts: ["a.ts"], check: ["npm", "test"] })
    + entry({ id: "ledger", title: "Ledger", kind: "state-machine", tool: "quint", status: "planned", target: "X-1" });
  await withTempDir("block", async (repo) => {
    writeRepoFile(repo, ".agent-configs/specs.toml", registryText);
    const before = "# Agents\n\nHand-written text before the block.\n";
    const stale = `# Claude\n\nIntro.\n\n${BLOCK_BEGIN}\nold managed text\n${BLOCK_END}\n\nHand-written text after the block.\n`;
    writeRepoFile(repo, "AGENTS.md", before);
    writeRepoFile(repo, "CLAUDE.md", stale);
    const drift = blockChecks(repo, "check").checks;
    assert(drift.length === 2 && drift.every((check) => check.status === "error"), "block --check did not report drift in both files");
    assert(blockChecks(repo, "apply").checks.every((check) => check.status === "ok"), "block --apply failed");
    const agents = readFileSync(join(repo, "AGENTS.md"), "utf8");
    const claude = readFileSync(join(repo, "CLAUDE.md"), "utf8");
    assert(agents.startsWith(`${before}\n${BLOCK_BEGIN}\n`) && agents.endsWith(`${BLOCK_END}\n`), "block --apply changed text outside the markers in AGENTS.md");
    assert(claude.startsWith(`# Claude\n\nIntro.\n\n${BLOCK_BEGIN}\n`) && claude.endsWith(`${BLOCK_END}\n\nHand-written text after the block.\n`) && !claude.includes("old managed text"), "block --apply changed text outside the markers in CLAUDE.md");
    assert(agents.includes("| `schema` | effect-schema | checked | required |") && agents.includes("Planned: `ledger` (quint, X-1).") && agents.includes("1. Before you change behaviour"), "the block lost the table, the planned list or the agent loop");
    assert(blockChecks(repo, "check").checks.every((check) => check.status === "ok"), "block --check reported drift right after --apply");
    assert(blockChecks(repo, "apply").checks.every((check) => check.detail === "already up to date") && readFileSync(join(repo, "AGENTS.md"), "utf8") === agents, "a second block --apply was not a no-op");
    const decoded = parseRegistry(registryText);
    assert(decoded.ok && renderSpecBlock(decoded.registry, ["step"]) === renderSpecBlock(decoded.registry, ["step"]), "block rendering is not deterministic");
  });
  await withTempDir("block-new", async (repo) => {
    writeRepoFile(repo, ".agent-configs/specs.toml", registryText);
    assert(blockChecks(repo, "apply").checks[0]?.detail === "created" && existsSync(join(repo, "AGENTS.md")) && !existsSync(join(repo, "CLAUDE.md")), "block --apply did not create AGENTS.md alone");
  });
  await withTempDir("block-escape", async (dir) => {
    const repo = join(dir, "repo");
    writeRepoFile(repo, ".agent-configs/specs.toml", registryText);
    writeRepoFile(dir, "outside.md", "outside\n");
    symlinkSync(join(dir, "outside.md"), join(repo, "AGENTS.md"));
    const escaped = blockChecks(repo, "apply").checks;
    assert(escaped.some((check) => check.status === "error") && readFileSync(join(dir, "outside.md"), "utf8") === "outside\n", "block --apply wrote through a symlink out of the repository");
    assert("error" in resolveInsideRepo(repo, "../outside.md") && "error" in resolveInsideRepo(repo, "AGENTS.md"), "resolveInsideRepo accepted a path outside the repository");
  });
  assert("error" in applyBlock(`${BLOCK_BEGIN}\n${BLOCK_BEGIN}\n${BLOCK_END}\n`, `${BLOCK_BEGIN}\nx\n${BLOCK_END}`), "duplicate markers were not refused");
  const crlf = applyBlock("# Title\r\n", `${BLOCK_BEGIN}\nx\n${BLOCK_END}`);
  assert("text" in crlf && !/[^\r]\n/u.test(crlf.text), "CRLF line endings were not kept");

  await withTempDir("init", async (repo) => {
    const printed = initRegistry(repo, { apply: false, name: "Init-Test" });
    assert(printed.template?.includes('repo = "Init-Test"') && parseRegistry(printed.template).ok && !existsSync(join(repo, ".agent-configs")), "init without --apply wrote a file or printed a bad template");
    assert(initRegistry(repo, { apply: true, name: "Init-Test" }).checks[0].status === "ok", "init --apply failed in an empty repository");
    const file = join(repo, ".agent-configs", "specs.toml");
    writeFileSync(file, "# edited by hand\n");
    const again = initRegistry(repo, { apply: true, name: "Init-Test" });
    assert(again.checks[0].status === "error" && readFileSync(file, "utf8") === "# edited by hand\n", "init --apply overwrote an existing registry");
    assert(initRegistry(repo, { apply: false, name: "bad name" }).checks[0].status === "error", "init accepted an invalid repository name");
  });
  await withTempDir("init-escape", async (dir) => {
    const repo = join(dir, "repo");
    mkdirSync(join(dir, "elsewhere"), { recursive: true });
    mkdirSync(repo, { recursive: true });
    symlinkSync(join(dir, "elsewhere"), join(repo, ".agent-configs"));
    assert(initRegistry(repo, { apply: true, name: "x" }).checks[0].status === "error" && !existsSync(join(dir, "elsewhere", "specs.toml")), "init --apply wrote through a symlinked .agent-configs");
  });
}

function specCliChecks(): void {
  const cli = (...args: string[]) => runCommand("node", ["--experimental-strip-types", "--no-warnings", join(ROOT, "src", "cli.ts"), "spec", ...args], { cwd: ROOT, timeoutMs: 60_000 });
  const validated = cli("validate", "--repo", ROOT, "--json");
  const payload = JSON.parse(validated.stdout || "{}");
  assert(validated.exitCode === 0 && payload.schema_version === 1 && payload.summary?.error === 0 && Array.isArray(payload.checks), `spec validate --json failed: ${validated.stderr || validated.stdout}`);
  assert(cli("schema", "--check").exitCode === 0, "spec schema --check failed on the committed schema");
  assert(cli("bogus").exitCode === 2 && cli("check", "--write").exitCode === 2, "a bad spec command or option did not exit 2");
}

function encodingChecks(): void {
  // Ruby must read the store's UTF-8 files as UTF-8 even when the caller has no UTF-8 locale.
  const probe = runCommand("ruby", ["-e", "print Encoding.default_external.name"], { env: { LANG: "", LC_ALL: "", LC_CTYPE: "" } });
  assert(probe.exitCode === 0 && probe.stdout.trim() === "UTF-8", `ruby reads files as ${probe.stdout.trim() || probe.stderr.trim()}, not UTF-8`);
}

async function main(): Promise<void> {
  for (const file of ["web/index.html", "web/styles.css", "web/app.js", "web/assets/ci-common/tokens.css", "web/assets/ci-common/logo-mark.svg"]) assert(fileExists(file), `missing asset: ${file}`);
  assert(readText("web/index.html").includes("CI Agent Sync"), "wizard name is stale");
  assert(readText("web/styles.css").includes("--primary"), "wizard does not use CI-Common semantic tokens");
  const validation = runCommand("node", ["--experimental-strip-types", "--no-warnings", join(ROOT, "src", "cli.ts"), "check"], { cwd: ROOT, timeoutMs: 60_000 });
  assert(validation.exitCode === 0, `store validation failed: ${validation.stderr || validation.stdout}`);

  const timeoutProbe = await runCommandAsync(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { cwd: ROOT, timeoutMs: 100 });
  assert(timeoutProbe.timedOut && timeoutProbe.exitCode === null && timeoutProbe.errorCode === "ETIMEDOUT", "async command timeout did not fail closed");
  const outputProbe = await runCommandAsync(process.execPath, ["-e", "process.stdout.write('x'.repeat(70000))"], { cwd: ROOT, timeoutMs: 2_000, maxBuffer: 1_024 });
  assert(outputProbe.outputTruncated && outputProbe.exitCode === null && outputProbe.errorCode === "MAX_BUFFER", "async command output cap did not fail closed");
  kvmChecks();
  itfChecks();
  registryDecodeChecks();
  registrySchemaChecks();
  storeVerificationChecks();
  argumentAndPathChecks();
  await probeChecks();
  await checkRunnerChecks();
  await blockAndInitChecks();
  specCliChecks();
  encodingChecks();
  assert(!safeDetail('{"apiKey":"not-for-output"}').includes("not-for-output"), "structured secret detail was not redacted");
  assert((redactSecrets({ apiKey: "not-for-output", status: "ok" }) as any).apiKey === "<redacted>", "structured payload secret was not redacted");
  const tailnet = summarizeTailscaleStatus({
    Self: { HostName: "laptop", DNSName: "laptop.example.ts.net.", Online: true, TailscaleIPs: ["100.64.0.1"] },
    Peer: { one: { HostName: "core-1", Online: true, OS: "linux", TailscaleIPs: ["100.64.0.2"] }, two: { HostName: "retired", Online: false, OS: "linux", TailscaleIPs: [] } },
  });
  assert(tailnet.available && tailnet.summary.online === 2 && tailnet.summary.offline === 1, "Tailscale evidence summary is incorrect");

  const child = spawn("node", ["--experimental-strip-types", "--no-warnings", join(ROOT, "src", "cli.ts"), "atlas", "--port", "0"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const started = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TypeScript wizard did not start within 5 seconds")), 5_000);
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  try {
    const port = await started;
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert(health.status === 200, `health status ${health.status}`);
    const overview = await fetch(`http://127.0.0.1:${port}/api/overview`);
    const payload = await overview.json() as any;
    assert(overview.status === 200 && payload.app?.name === "CI Agent Sync", "overview payload is stale");
    const tokens = await fetch(`http://127.0.0.1:${port}/assets/ci-common/tokens.css`);
    assert(tokens.status === 200 && (await tokens.text()).includes("--background"), "vendored token asset is not served");
    const guarded = await fetch(`http://127.0.0.1:${port}/api/action/backup`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert(guarded.status === 400, "backup action lost its confirmation guard");
    const unknownCheck = await fetch(`http://127.0.0.1:${port}/api/check/unknown`);
    const unknownPayload = await unknownCheck.json() as any;
    assert(unknownCheck.status === 503 && unknownPayload.status === "error", "failed checks did not return a failing HTTP status");
    const oversized = await fetch(`http://127.0.0.1:${port}/api/action/backup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirm: true, padding: "x".repeat(70_000) }) });
    assert(oversized.status === 413, "action body limit did not fail closed");
  } finally {
    child.kill("SIGTERM");
  }
  console.log("CI Agent Sync TypeScript checks passed");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
