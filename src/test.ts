import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml } from "yaml";
import { TOKEN_HEADER, docsPath, refusal, type Boundary } from "./atlas-web.ts";
import { HOME, ROOT, fileExists, readText, redactSecrets, runCommand, runCommandAsync, safeChildPath, safeDetail } from "./core.ts";
import { ACTION_TAKEN, ItfError, NONDET_PICKS, decodeItfValue, itfAction, itfPicks, parseItfTrace, type ItfValue } from "./itf.ts";
import { classifyNanoKvmMcp, classifyProduct, envName, loadKvmTargets, mcpSnippet, nanoKvmKeyEnv, rowStatus } from "./kvm.ts";
import { RENDER_MARKER, protectedOutputReason, renderArtifacts } from "./operations.ts";
import { childWithin } from "./path-containment.ts";
import { summarizeTailscaleStatus } from "./platform.ts";
import { credentialScanChecks } from "./credential-scan.test.ts";
import { redactConfigChecks } from "./redact-config.test.ts";
import { storeCommandChecks } from "./store-commands.test.ts";
import { SPEC_GATES, SPEC_KINDS, SPEC_STATUSES, SPEC_TOOLS, parseRegistry, type SpecEntry } from "./spec-registry.ts";
import { entry, specRegistryChecks } from "./spec-registry.test.ts";
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
  probeDirs,
  renderSpecBlock,
  resolveInsideRepo,
  validateChecks,
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
  await withTempDir("probe-pnp", async (repo) => {
    writeRepoFile(repo, ".pnp.cjs", "// Yarn Plug'n'Play loader\n");
    const pnp = await probeToolchain(fakeToolchain({ id: "fake-lib", kind: "library", version: "1.2.3", probe: { kind: "package", package: "fake-lib" } }), { repo });
    assert(pnp.status === "not-installed" && !pnp.usable && pnp.detail.includes("Plug'n'Play"), `a Plug'n'Play repository was not named as the reason: ${pnp.detail}`);
  });
}

/**
 * Run `task` and count the child processes it starts. The node:child_process exports are
 * wrapped and synced into the ESM bindings, so the spawn that core.ts imports is counted.
 */
async function countChildProcesses<T>(task: () => Promise<T>): Promise<{ result: T; started: number }> {
  const childProcess = createRequire(import.meta.url)("node:child_process");
  const originals = new Map(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"].map((name) => [name, childProcess[name]]));
  let started = 0;
  for (const [name, original] of originals) {
    childProcess[name] = (...args: unknown[]) => {
      started += 1;
      return original(...args);
    };
  }
  syncBuiltinESMExports();
  try {
    const result = await task();
    return { result, started };
  } finally {
    for (const [name, original] of originals) childProcess[name] = original;
    syncBuiltinESMExports();
  }
}

// A monorepo keeps a tool in a workspace package, so probes look in node_modules from the
// entry's own directories up to the repository root, and never above it or through a
// symlink out of it. A package probe runs nothing.
async function workspaceProbeChecks(): Promise<void> {
  await withTempDir("probe-workspace", async (dir) => {
    const repo = join(dir, "repo");
    writeRepoFile(repo, "apps/web/node_modules/fake-ui/package.json", JSON.stringify({ name: "fake-ui", version: "2.0.0", bin: { "fake-ui": "cli.js" } }));
    writeRepoFile(repo, "apps/web/node_modules/fake-ui/cli.js", "require('node:fs').writeFileSync(__dirname + '/ran', '');\n");
    writeRepoFile(repo, "apps/web/src/Button.stories.tsx", "export {};\n");
    writeRepoFile(repo, "packages/ui/src/index.ts", "export {};\n");
    writeRepoFile(repo, "spec/a.txt", "x\n");
    // The same package outside the repository: above its root, and behind a symlink in it.
    writeRepoFile(dir, "node_modules/fake-ui/package.json", JSON.stringify({ name: "fake-ui", version: "2.0.0" }));
    writeRepoFile(dir, "elsewhere/node_modules/fake-ui/package.json", JSON.stringify({ name: "fake-ui", version: "2.0.0" }));
    writeRepoFile(dir, "elsewhere/src/x.ts", "export {};\n");
    symlinkSync(join(dir, "elsewhere"), join(repo, "apps", "linked"));
    const root = realpathSync(repo);
    const names = (dirs: string[]) => dirs.map((path) => relative(root, path).split(sep).join("/"));

    const fromArtefact = probeDirs(repo, { artefacts: ["apps/web/src/Button.stories.tsx"] });
    assert(isDeepStrictEqual(names(fromArtefact), ["apps/web/src", "apps/web", "apps", ""]), `an artefact's directories were wrong: ${names(fromArtefact).join(", ")}`);
    const ordered = probeDirs(repo, { workdir: "apps/web", artefacts: ["spec/a.txt"], covers: ["packages/ui/src/**", "**/*.ts", "missing/dir/x.ts"] });
    assert(isDeepStrictEqual(names(ordered), ["apps/web", "apps", "spec", "packages/ui/src", "packages/ui", "packages", ""]), `the workdir, artefact and covers directories were wrong: ${names(ordered).join(", ")}`);
    const linked = probeDirs(repo, { artefacts: ["apps/linked/src/x.ts"], covers: ["apps/linked/**"] });
    assert(isDeepStrictEqual(names(linked), ["apps", ""]), `a symlink out of the repository was searched: ${names(linked).join(", ")}`);

    const fakeUi = fakeToolchain({ id: "fake-ui", version: "2.0.0", provides: ["storybook"], probe: { kind: "package", package: "fake-ui" } });
    const found = await countChildProcesses(() => probeToolchain(fakeUi, { repo, dirs: fromArtefact }));
    assert(found.result.status === "ok" && found.result.usable && found.result.detail.includes("apps/web/node_modules/fake-ui"), `a package in a workspace was not found from an artefact path: ${found.result.detail}`);
    assert(found.started === 0 && !existsSync(join(repo, "apps/web/node_modules/fake-ui/ran")), `a package probe ran something (${found.started} child processes)`);
    const control = await countChildProcesses(() => probeToolchain(nodeToolchain, { repo }));
    assert(control.result.usable && control.started > 0, "the child process count missed a command probe, so it proves nothing");
    const atRoot = await probeToolchain(fakeUi, { repo });
    assert(atRoot.status === "not-installed" && !atRoot.usable && atRoot.detail.includes("no node_modules/fake-ui in the repository root"), `a package above the repository root was found: ${atRoot.detail}`);

    const common = { kind: "component", tool: "storybook", status: "checked", gate: "required", requires: ["fake-ui"], check: [process.execPath, "-e", "0"] };
    writeRepoFile(repo, ".agent-configs/specs.toml", 'version = 1\nrepo = "workspace-test"\n\n'
      + entry({ id: "web", title: "Web", ...common, artefacts: ["apps/web/src/Button.stories.tsx"] })
      + entry({ id: "root", title: "Root", ...common, artefacts: ["spec/a.txt"] })
      + entry({ id: "linked", title: "Linked", ...common, artefacts: ["apps/linked/src/x.ts"], covers: ["apps/linked/**"] }));
    const { checks } = await checkEntries({ repo, toolchains: [fakeUi] });
    const byId = new Map(checks.map((check) => [check.id, check]));
    assert(byId.get("spec.web")?.status === "ok", `an entry did not find its tool in its workspace package: ${byId.get("spec.web")?.detail}`);
    assert(byId.get("spec.root")?.status === "error" && String(byId.get("spec.root")?.detail).includes("no node_modules/fake-ui in spec or the repository root"), `a tool outside the repository was found: ${byId.get("spec.root")?.detail}`);
    assert(byId.get("spec.linked")?.status === "error" && String(byId.get("spec.linked")?.detail).includes("no node_modules/fake-ui in apps or the repository root"), `a tool behind a symlink out of the repository was found: ${byId.get("spec.linked")?.detail}`);

    // The node_modules/.bin lookup follows the same directories, and entries that find a
    // command in the same place share one probe.
    if (process.platform !== "win32") {
      writeRepoFile(repo, "apps/web/node_modules/.bin/agent-sync-fake-cli", "#!/bin/sh\necho 'agent-sync-fake-cli 3.1.4'\n");
      chmodSync(join(repo, "apps/web/node_modules/.bin/agent-sync-fake-cli"), 0o755);
      const fakeCli = fakeToolchain({ id: "fake-cli", version: "3.1.4", probe: { kind: "command", commands: ["agent-sync-fake-cli"], args: ["--version"], stream: "stdout", pattern: "(\\d+\\.\\d+\\.\\d+)" } });
      const fromWeb = await probeToolchain(fakeCli, { repo, dirs: fromArtefact });
      const fromRoot = await probeToolchain(fakeCli, { repo });
      assert(fromWeb.status === "ok" && fromWeb.version === "3.1.4" && fromRoot.status === "not-installed", `a command in a workspace's node_modules/.bin was resolved wrongly: ${fromWeb.detail}; ${fromRoot.detail}`);
      const cli = { ...common, tool: "property", kind: "invariant", requires: ["fake-cli"] };
      writeRepoFile(repo, ".agent-configs/specs.toml", 'version = 1\nrepo = "workspace-test"\n\n'
        + entry({ id: "cli-a", title: "A", ...cli, artefacts: ["apps/web/src/Button.stories.tsx"] })
        + entry({ id: "cli-b", title: "B", ...cli, workdir: "apps/web", artefacts: ["apps/web/src/Button.stories.tsx"] }));
      const shared = await countChildProcesses(() => checkEntries({ repo, toolchains: [fakeCli] }));
      const passed = shared.result.checks.filter((check) => check.status === "ok").map((check) => check.id);
      assert(isDeepStrictEqual(passed, ["spec.cli-a", "spec.cli-b"]) && shared.started === 3, `two entries did not share one probe of the same command (${shared.started} child processes; ok: ${passed.join(", ")})`);
    }
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
  Object.assign(duplicated.toolchains.find((item: any) => item.id === "storybook").probe, { command: "storybook", args: ["--version"] });
  const broken = structuredClone(policy);
  broken.change_classes[0].tools.push("tla-plus");
  const failing = verificationChecks({ toolchains: duplicated, policy: broken, registries: [{ id: "bad", file: "x", text: 'version = 1\nrepo = "x"\n' + entry({ id: "a", title: "A", kind: "protocol", tool: "quint", status: "planned", requires: ["no-such-toolchain"] }) }], decode: parseRegistry, vocabulary });
  const errors = failing.filter((check) => check.status === "error").map((check) => `${check.id}: ${check.detail}`);
  assert(errors.some((error) => error.startsWith("verification.toolchain.quint: duplicate id")), `a duplicate toolchain id was not caught: ${errors.join("; ")}`);
  assert(errors.some((error) => error.startsWith("verification.toolchain.bombadil: not_for")), `a tool without not_for was not caught: ${errors.join("; ")}`);
  assert(errors.some((error) => error === "verification.toolchain.storybook: a package probe runs nothing, so it takes no command, args"), `a package probe with command fields was not caught: ${errors.join("; ")}`);
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

  // A registry edit can change any entry's check, bound, gate or status, and the package
  // manifest or a lockfile can change what a check runs, so both select entries too.
  const withCheck = { title: "T", kind: "protocol", tool: "quint", status: "checked", artefacts: ["spec/a.qnt"], check: ["npm", "test"] } as const;
  const sample: SpecEntry[] = [
    { id: "root", ...withCheck, covers: ["lib/**"] },
    { id: "app", ...withCheck, workdir: "./app/", covers: ["app/src/**"] },
    { id: "later", title: "L", kind: "protocol", tool: "quint", status: "planned", covers: ["lib/**"] },
  ];
  const touchedIds = (files: string[]) => entriesTouchedBy(sample, files).map((item) => item.id);
  assert(isDeepStrictEqual(touchedIds(["package.json"]), ["root", "app"]), "a root package.json change did not select every entry with a check");
  assert(isDeepStrictEqual(touchedIds(["app/pnpm-lock.yaml"]), ["app"]), "a lockfile in a workdir did not select its entry alone");
  assert(isDeepStrictEqual(touchedIds([".agent-configs/specs.toml"]), ["root", "app", "later"]), "a registry change did not select every entry");
  assert(isDeepStrictEqual(touchedIds(["docs/x.md", "app/package.json.bak"]), []), "an unrelated change selected an entry");

  // An entry's tool fixes its environment (telemetry opt-outs) even when `requires` leaves
  // its toolchain out, and both validate and check say that the tool is not probed.
  await withTempDir("check-tool", async (repo) => {
    writeRepoFile(repo, "spec/a.txt", "x\n");
    const optOut = fakeToolchain({ id: "fake-ui", provides: ["storybook"], environment: [{ name: "AGENT_SYNC_TEST_OPT_OUT", value: "1" }], probe: { kind: "command", commands: ["agent-sync-no-such-tool"], args: ["--version"], stream: "both", pattern: "(\\d+)" } });
    writeRepoFile(repo, ".agent-configs/specs.toml", 'version = 1\nrepo = "tool-test"\n\n'
      + entry({ id: "stories", title: "Stories", kind: "component", tool: "storybook", status: "checked", artefacts: ["spec/a.txt"], requires: ["node"], check: [process.execPath, "-e", "process.exit(process.env.AGENT_SYNC_TEST_OPT_OUT === '1' ? 0 : 7)"] })
      + entry({ id: "later", title: "Later", kind: "component", tool: "storybook", status: "planned" }));
    const ran = await checkEntries({ repo, toolchains: [nodeToolchain, optOut] });
    const run = ran.checks.find((check) => check.id === "spec.stories");
    assert(run?.status === "ok", `the tool's environment was not set for its check: ${run?.detail}`);
    assert(ran.checks.some((check) => check.id === "spec.stories.requires" && check.status === "warn" && check.detail.includes('"fake-ui"')), "check did not warn that requires leaves out the tool's toolchain");
    const validated = validateChecks(repo, { toolchains: [nodeToolchain, optOut] });
    assert(validated.some((check) => check.id === "spec.stories.requires" && check.status === "warn"), "validate did not warn that requires leaves out the tool's toolchain");
    assert(!validated.some((check) => check.id === "spec.later.requires"), "validate warned about requires on a planned entry, which has nothing to probe");
  });
}

// A descendant that leaves the process group and keeps stdout open must not hold up the
// result, after a normal exit or after a timeout.
async function heldOutputChecks(): Promise<void> {
  const holder = (wait: boolean) => ["-e", [
    'const { spawn } = require("node:child_process");',
    'const held = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });',
    "held.unref();",
    'console.log("holder " + held.pid);',
    wait ? "setTimeout(() => {}, 15000);" : "",
  ].join("\n")];
  const holders: number[] = [];
  const holderStarted = (stdout: string): boolean => {
    const match = /holder (\d+)/u.exec(stdout);
    if (match) holders.push(Number(match[1]));
    return match !== null;
  };
  try {
    const started = Date.now();
    const done = await runCommandAsync(process.execPath, holder(false), { cwd: ROOT, timeoutMs: 10_000 });
    const doneMs = Date.now() - started;
    assert(holderStarted(done.stdout) && done.exitCode === 0 && !done.timedOut && doneMs < 5_000, `a held-open pipe kept a finished command waiting ${doneMs} ms (exit ${done.exitCode})`);
    const hungStarted = Date.now();
    const hung = await runCommandAsync(process.execPath, holder(true), { cwd: ROOT, timeoutMs: 1_000 });
    const hungMs = Date.now() - hungStarted;
    assert(holderStarted(hung.stdout) && hung.timedOut && hung.exitCode === null && hungMs < 6_000, `a held-open pipe kept a timed-out command waiting ${hungMs} ms`);
  } finally {
    for (const pid of holders) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
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
    const withSkills = renderSpecBlock(decoded.registry, ["step"], { skills: true });
    assert(!renderSpecBlock(decoded.registry, ["step"]).includes("skills/") && withSkills.includes("npx skills add companionintelligence/CI-Agent-Sync"), "the skills pointer did not follow the skills option");
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
    assert(initRegistry(repo, { apply: true, name: "x" }).checks[0].status === "error" && !existsSync(join(dir, "elsewhere", "specs.toml")), "init --apply wrote outside the repository");
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

// Fake credential values, built at run time in every format the redactors know, in the
// places they turn up. No redactor may let one through. Seeded, so a failure repeats.
function generatedRedactionChecks(): void {
  const seed = 0x5ec2e7;
  let state = seed;
  const draw = (alphabet: string, length: number): string => Array.from({ length }, () => {
    state = (state * 48_271) % 2_147_483_647;
    return alphabet[state % alphabet.length];
  }).join("");
  const mixed = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const digits = "0123456789";
  const hex = "0123456789abcdef";
  const shapes: Array<[string, () => string]> = [
    ["an OpenAI key", () => `sk-${draw(mixed, 48)}`],
    ["an OpenAI project key", () => `sk-proj-${draw(mixed, 48)}`],
    ["an Anthropic key", () => `sk-ant-api03-${draw(mixed, 40)}`],
    ["an OpenRouter key", () => `sk-or-v1-${draw(hex, 40)}`],
    ["a Stripe key", () => `sk_live_${draw(mixed, 24)}`],
    ["a Google API key", () => `AIza${draw(mixed, 35)}`],
    ["a Hugging Face token", () => `hf_${draw(mixed, 34)}`],
    ["an npm token", () => `npm_${draw(mixed, 36)}`],
    ["a GitLab token", () => `glpat-${draw(mixed, 20)}`],
    ["a GitHub token", () => `ghp_${draw(mixed, 36)}`],
    ["a GitHub app token", () => `ghs_${draw(mixed, 36)}`],
    ["a GitHub fine-grained token", () => `github_pat_${draw(mixed, 22)}_${draw(mixed, 59)}`],
    ["a Slack bot token", () => ["xo", `xb-${draw(digits, 12)}-${draw(mixed, 24)}`].join("")],
    ["a Slack app token", () => `xapp-1-${draw(upper, 11)}-${draw(digits, 13)}-${draw(hex, 64)}`],
    ["an AWS access key id", () => `AKIA${draw(upper, 16)}`],
    ["a temporary AWS access key id", () => `ASIA${draw(upper, 16)}`],
    ["a JSON Web Token", () => `eyJ${draw(mixed, 20)}.eyJ${draw(mixed, 30)}.${draw(mixed, 43)}`],
  ];
  // Where a value sits says it is secret, whether or not it has a shape of its own.
  const places: Array<[string, (value: string) => string]> = [
    ["a Bearer header", (value) => `Authorization: Bearer ${value}`],
    ["a token authorization header", (value) => `Authorization: token ${value}`],
    ["an x-api-key header", (value) => `x-api-key: ${value}`],
    ["a token variable", (value) => `export GITHUB_TOKEN=${value}`],
    ["an AWS secret variable", (value) => `AWS_SECRET_ACCESS_KEY=${value}`],
    ["a --token flag", (value) => `gh auth login --token ${value}`],
    ["a --password= flag", (value) => `tool --password=${value} --verbose`],
    ["a URL password", (value) => `https://x-access-token:${value}@example.invalid/o/r`],
    ["a URL user", (value) => `https://${value}@example.invalid/o/r.git`],
    ["a query token", (value) => `GET /callback?access_token=${value}&state=1`],
    ["a JSON field", (value) => JSON.stringify({ apiKey: value, other: "kept" })],
    ["a Cookie header", (value) => `Cookie: theme=dark; session=${value}`],
  ];
  const survivor = (text: string, value: string): string | null => {
    if (safeDetail(text).includes(value)) return "safeDetail";
    if (String(redactSecrets(text)).includes(value)) return "redactSecrets";
    if (text.startsWith("{") && JSON.stringify(redactSecrets(JSON.parse(text))).includes(value)) return "redactSecrets on the object";
    return null;
  };
  const check = (what: string, text: string, value: string, round: number): void => {
    const found = survivor(text, value);
    assert(found === null, `${found} let ${what} through (seed ${seed}, round ${round})`);
  };
  for (let round = 0; round < 25; round += 1) {
    for (const [label, make] of shapes) {
      const value = make();
      check(`${label} in plain text`, `request failed for ${value} today`, value, round);
      for (const [place, wrap] of places) check(`${label} in ${place}`, wrap(value), value, round);
    }
    for (const [place, wrap] of places) {
      const value = `q1${draw(mixed, 30)}`;
      check(`a value in ${place}`, wrap(value), value, round);
    }
  }
  // A private key, whole or cut off, also when only the last 20 lines are kept.
  const lines = [draw(mixed, 64), draw(mixed, 64)];
  const kind = ["PRIVATE", "KEY"].join(" ");
  const later = Array(19).fill("next line").join("\n");
  check("a private key", `-----BEGIN ${kind}-----\n${lines.join("\n")}\n-----END ${kind}-----\n${later}`, lines[1], 0);
  check("a cut-off private key", `-----BEGIN RSA ${kind}-----\n${lines.join("\n")}\n${later}`, lines[1], 0);
}

// Credential shapes in report output become a fixed placeholder, the text around them is
// kept, and ordinary text passes through unchanged. Every value here is synthetic and is
// built at run time, so the source holds nothing credential-shaped.
async function redactionChecks(): Promise<void> {
  const body = "Q7xT2mK9vR4wZ8nB".repeat(4);
  const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ sub: "someone", iat: 0 })}.${body.slice(0, 43)}`;
  const shapes: Array<[string, string]> = [
    ...["p", "o", "u", "s", "r"].map((letter): [string, string] => [`a GitHub gh${letter}_ token`, `gh${letter}_${body.slice(0, 36)}`]),
    ["a GitHub fine-grained token", `github_pat_${body.slice(0, 22)}_${body.slice(0, 59)}`],
    ...["a", "b", "p", "r", "s"].map((letter): [string, string] => [`a Slack xox${letter}- token`, `xox${letter}-1234567890-1234567890123-${body.slice(0, 24)}`]),
    ["an sk- key", `sk-${body.slice(0, 48)}`],
    ["an sk-proj- key", `sk-proj-${body}`],
    ["an sk-ant- key", `sk-ant-api03-${body}`],
    ["an AWS access key id", `AKIA${body.slice(0, 16).toUpperCase()}`],
    ["a JSON Web Token", jwt],
    ["an unsigned JSON Web Token", `${base64url({ alg: "none" })}.${base64url({ sub: "someone" })}.`],
  ];
  for (const [label, secret] of shapes) {
    const redacted = safeDetail(`before ${secret} after`);
    assert(redacted === "before [REDACTED] after", `${label} was not replaced with the text around it kept: ${redacted}`);
  }

  const password = `not-a-real-${body.slice(0, 12)}`;
  const basic = Buffer.from(`someone:${password}`).toString("base64");
  const github = `ghs_${body.slice(0, 36)}`;
  const inContext: Array<[string, string, string]> = [
    ["a Bearer value", `Authorization: Bearer ${body}`, "Authorization: Bearer [REDACTED]"],
    ["a Basic header", `Authorization: Basic ${basic}`, "Authorization: Basic [REDACTED]"],
    ["a Basic header in JSON", `{"authorization": "Basic ${basic}", "accept": "*/*"}`, '{"authorization": "Basic [REDACTED]", "accept": "*/*"}'],
    ["a Basic value without a header", `retrying with Basic ${basic} now`, "retrying with Basic [REDACTED] now"],
    ["a URL password", `cloning https://someone:${password}@example.invalid/repo.git failed`, "cloning https://someone:[REDACTED]@example.invalid/repo.git failed"],
    ["a URL password with an @ in it", `redis://:p@ss${password}@cache.example.invalid:6379/0`, "redis://:[REDACTED]@cache.example.invalid:6379/0"],
    ["a token as a URL password", `https://x-access-token:${github}@github.com/o/r.git`, "https://x-access-token:[REDACTED]@github.com/o/r.git"],
    ["a token as a URL user", `https://${github}@github.com/o/r.git`, "https://[REDACTED]@github.com/o/r.git"],
    ["a token after a key", `export GITHUB_TOKEN=${github}; npm test`, "export GITHUB_TOKEN=[REDACTED]; npm test"],
  ];
  for (const [label, text, expected] of inContext) {
    const redacted = safeDetail(text);
    assert(redacted === expected, `${label} was redacted wrongly: ${redacted}`);
  }

  const ordinary = [
    "commit a5324b2f8bb45e9638fb6aec6c18dc63818432bc (HEAD -> fix/verification-review), parent 7094152",
    "Basic functionality works; Basic data and Basic auth checks passed",
    "task-runner-for-everything and disk-cleanup-scheduled-nightly finished in 1.2 s",
    "see https://example.invalid/docs#section and http://localhost:3000/path?x=1",
    "ssh://deploy@127.0.0.1:2222/srv/repo and http://[::1]:8080/health",
    "AKIA is a prefix, eyJ starts base64 JSON, and 4 of 4 checks passed",
    "MAX_TOKENS=4096 TOKENIZERS_PARALLELISM=false TOKEN_URL=https://example.invalid/oauth",
    "usage: tool --token <TOKEN> --password PASSWORD or --token-file ./token.txt",
    "npm_config_cache=/tmp/cache npm_package_version=0.2.0, git@example.invalid:o/r.git",
  ];
  for (const line of ordinary) {
    assert(safeDetail(line) === line, `ordinary text was changed: ${safeDetail(line)}`);
    assert(redactSecrets(line) === line, `ordinary payload text was changed: ${redactSecrets(line)}`);
  }

  generatedRedactionChecks();

  const payload = redactSecrets({ note: `pushed with ${github}`, nested: [`session ${jwt}`] }) as { note: string; nested: string[] };
  assert(payload.note === "pushed with [REDACTED]" && payload.nested[0] === "session [REDACTED]", "payload strings were not redacted with the same shapes");

  // A failing check's detail in `agentctl spec check` goes through the same redaction.
  await withTempDir("check-redaction", async (repo) => {
    writeRepoFile(repo, "spec/a.txt", "x\n");
    const leak = "console.error('pushing with gh' + 'p_' + 'Q7xT2mK9'.repeat(5) + ' to https://someone:' + 'pw'.repeat(8) + '@example.invalid/x'); process.exit(1)";
    writeRepoFile(repo, ".agent-configs/specs.toml", 'version = 1\nrepo = "redaction-test"\n\n'
      + entry({ id: "leaky", title: "Leaky", kind: "invariant", tool: "property", status: "checked", artefacts: ["spec/a.txt"], check: [process.execPath, "-e", leak] }));
    const { checks } = await checkEntries({ repo, toolchains: [] });
    const leaky = checks.find((check) => check.id === "spec.leaky");
    assert(leaky?.status === "warn" && leaky.detail === "failed with exit 1\npushing with [REDACTED] to https://someone:[REDACTED]@example.invalid/x", `a failing check's output was not redacted: ${leaky?.detail}`);
  });
}

function encodingChecks(): void {
  // Ruby must read the store's UTF-8 files as UTF-8 even when the caller has no UTF-8 locale.
  const probe = runCommand("ruby", ["-e", "print Encoding.default_external.name"], { env: { LANG: "", LC_ALL: "", LC_CTYPE: "" } });
  assert(probe.exitCode === 0 && probe.stdout.trim() === "UTF-8", `ruby reads files as ${probe.stdout.trim() || probe.stderr.trim()}, not UTF-8`);
}

function containmentChecks(): void {
  // The verified core: a separator must follow the base.
  assert(childWithin("/a/b", "/a/b", "/") && childWithin("/a/b", "/a/b/c", "/"), "the base and paths under it must be inside the base");
  assert(!childWithin("/a/b", "/a/bc", "/"), "a sibling that shares the base's prefix must not be inside it");
  assert(!childWithin("/a/b", "/a", "/") && !childWithin("/a/b", "/b/a/b", "/"), "a parent or an unrelated path must not be inside the base");
  assert(childWithin("C:\\a", "C:\\a\\b", "\\") && !childWithin("C:\\a", "C:\\ab", "\\"), "the separator must come from the caller");

  // Render's hard stops hold even with --force, and compare folders by identity, not by spelling.
  assert(protectedOutputReason(sep) !== null && protectedOutputReason(HOME) !== null && protectedOutputReason(dirname(ROOT)) !== null, "render must never replace the file-system root or a folder that holds the home folder or this checkout");
  const shouted = dirname(ROOT).toUpperCase();
  const sameFolder = (a: string, b: string): boolean => { try { const x = statSync(a), y = statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; } };
  if (shouted !== dirname(ROOT) && sameFolder(shouted, dirname(ROOT))) assert(protectedOutputReason(shouted) !== null, "on a case-insensitive volume, another spelling of a folder that holds this checkout must be refused too");

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agent-sync-containment-")));
  try {
    // The wizard's file guard: paths above the root, a sibling sharing its prefix, and a symbolic link out.
    const web = join(scratch, "web");
    mkdirSync(web);
    mkdirSync(join(scratch, "webx"));
    writeFileSync(join(web, "inside.txt"), "inside\n");
    writeFileSync(join(scratch, "webx", "sibling.txt"), "sibling\n");
    writeFileSync(join(scratch, "outside.txt"), "outside\n");
    symlinkSync(join(scratch, "outside.txt"), join(web, "link.txt"));
    assert(safeChildPath(web, "/inside.txt") === join(web, "inside.txt"), "a file inside the root must be served");
    assert(safeChildPath(web, "/../outside.txt") === null, "a path above the root must be refused");
    assert(safeChildPath(web, "/../webx/sibling.txt") === null, "a folder that shares the root's prefix must be refused");
    assert(safeChildPath(web, "/link.txt") === null, "a symbolic link that leads out of the root must be refused");

    // The wizard's /docs/ route checks against docs/, so a link there cannot lead elsewhere in the checkout.
    const checkout = join(scratch, "checkout");
    mkdirSync(join(checkout, "docs"), { recursive: true });
    mkdirSync(join(checkout, "local"));
    writeFileSync(join(checkout, "docs", "guide.md"), "guide\n");
    writeFileSync(join(checkout, "local", "backup.json"), "{}\n");
    symlinkSync(join("..", "local", "backup.json"), join(checkout, "docs", "notes.md"));
    assert(docsPath(checkout, "/docs/guide.md") === join(checkout, "docs", "guide.md"), "the docs route must serve a file under docs/");
    assert(docsPath(checkout, "/docs/notes.md") === null, "the docs route must refuse a link under docs/ that leads elsewhere in the checkout");

    // Render's output guard: it replaces only folders it made, marks them, and needs --force otherwise.
    assert(protectedOutputReason(scratch) === null, "a scratch folder holds neither the home folder nor this checkout");
    const rendered = join(scratch, "rendered");
    assert(renderArtifacts({ agent: "vscode", output: rendered }).outputs.length > 0 && existsSync(join(rendered, RENDER_MARKER)), "render must mark the folder it creates");
    renderArtifacts({ agent: "vscode", output: rendered });
    writeFileSync(join(rendered, "my-notes.txt"), "mine\n");
    writeFileSync(join(rendered, "vscode", "stale.json"), "{}\n");
    renderArtifacts({ agent: "all", output: rendered });
    assert(existsSync(join(rendered, "my-notes.txt")) && existsSync(join(rendered, "vscode", "settings.json")) && !existsSync(join(rendered, "vscode", "stale.json")), "render must replace its own entries in its folder and keep a file the user added there");
    const legacy = join(scratch, "legacy");
    mkdirSync(join(legacy, "vscode"), { recursive: true });
    writeFileSync(join(legacy, "manifest.json"), JSON.stringify({ schema_version: 1, generated_at: "2026-01-01T00:00:00.000Z", machine: "macos-laptop", agent: "vscode", source_commit: null, outputs: ["vscode/settings.json"] }));
    writeFileSync(join(legacy, ".DS_Store"), "");
    renderArtifacts({ agent: "vscode", output: legacy });
    assert(existsSync(join(legacy, RENDER_MARKER)) && existsSync(join(legacy, ".DS_Store")), "a folder an earlier render wrote must be recognised by its manifest, also with a file browser's .DS_Store in it");
    const browsed = join(scratch, "browsed");
    mkdirSync(browsed);
    writeFileSync(join(browsed, ".DS_Store"), "");
    renderArtifacts({ agent: "vscode", output: browsed });
    assert(existsSync(join(browsed, RENDER_MARKER)), "a folder that holds only a file browser's .DS_Store must count as empty");
    const kept = join(scratch, "kept");
    mkdirSync(kept);
    writeFileSync(join(kept, "keep.txt"), "keep\n");
    symlinkSync(kept, join(scratch, "link-to-kept"));
    const refused = (output: string): boolean => {
      try {
        renderArtifacts({ agent: "all", output });
        return false;
      } catch (error) {
        return String(error).includes("--force");
      }
    };
    assert(refused(kept) && readdirSync(kept).join() === "keep.txt", "render must not replace a folder with files it did not create");
    assert(refused(join(scratch, "link-to-kept")) && readdirSync(kept).join() === "keep.txt", "render must not replace such a folder through a symbolic link");
    renderArtifacts({ agent: "vscode", output: kept, force: true });
    assert(existsSync(join(kept, "keep.txt")) && !existsSync(join(kept, RENDER_MARKER)) && refused(kept), "a forced render of one agent must not make a folder with other files render's own");
    renderArtifacts({ agent: "all", output: kept, force: true });
    assert(!existsSync(join(kept, "keep.txt")) && existsSync(join(kept, RENDER_MARKER)), "--force must let render replace the folder, and render must then mark it");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// mulberry32: a small generator with a fixed seed, so a failing case reproduces.
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// The reference compares whole segments, a different method from the core's prefix test.
function referenceWithin(base: string, candidate: string, separator: string): boolean {
  const baseSegments = base.split(separator);
  const candidateSegments = candidate.split(separator);
  return candidateSegments.length >= baseSegments.length && baseSegments.every((segment, index) => segment === candidateSegments[index]);
}

function containmentPropertyChecks(): void {
  const seed = 20_261_126;
  const random = seededRandom(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  const segments = ["a", "b", "ab", "ba", "a.b", "b-c", "..a", "a..", ".hidden", "é", "e\u0301", "😀", "x y"];
  const suffixes = ["c", "-x", ".bak", "😀", "a", " "];
  const pathOf = (separator: string, prefix: string, depth: number): string => prefix + Array.from({ length: depth }, () => pick(segments)).join(separator);
  const cases: Array<[string, string, string]> = [];

  // Every pair of short strings over "a", "b" and the separator.
  const alphabet = ["a", "b", "/"];
  const words = [""];
  for (let length = 1; length <= 4; length += 1) for (const word of words.filter((item) => item.length === length - 1)) for (const letter of alphabet) words.push(word + letter);
  for (const base of words) for (const candidate of words) cases.push([base, candidate, "/"]);

  // Generated absolute paths with near misses: the base, children, prefix-sharing siblings,
  // parents, renamed last segments, cut-off prefixes, doubled separators and unrelated paths.
  for (let index = 0; index < 20_000; index += 1) {
    const separator = random() < 0.8 ? "/" : "\\";
    const prefix = separator === "/" ? "/" : "C:\\";
    const base = pathOf(separator, prefix, 1 + Math.floor(random() * 4));
    const parts = base.slice(prefix.length).split(separator);
    const candidate = pick([
      () => base,
      () => `${base}${separator}${pathOf(separator, "", 1 + Math.floor(random() * 3))}`,
      () => `${base}${pick(suffixes)}`,
      () => `${base}${pick(suffixes)}${separator}${pick(segments)}`,
      () => prefix + parts.slice(0, -1).join(separator),
      () => prefix + [...parts.slice(0, -1), pick(segments)].join(separator),
      // Cut whole code points, so no case holds half a surrogate pair (Ruby's JSON rejects those).
      () => Array.from(base).slice(0, Math.floor(random() * Array.from(base).length)).join(""),
      () => `${base}${separator}${separator}${pick(segments)}`,
      () => `${base}${separator}`,
      () => pathOf(separator, prefix, 1 + Math.floor(random() * 4)),
    ])();
    cases.push([base, candidate, separator]);
  }
  for (const [base, candidate, separator] of cases) {
    assert(childWithin(base, candidate, separator) === referenceWithin(base, candidate, separator), `containment core disagrees with the reference (seed ${seed}): ${JSON.stringify([base, candidate, separator])}`);
  }
  const inside = cases.filter(([base, candidate, separator]) => childWithin(base, candidate, separator)).length;
  assert(inside > 2_000 && cases.length - inside > 2_000, `the generated cases are lopsided: ${inside} of ${cases.length} inside`);

  // sync's Ruby copy must make the same decision on the same cases.
  const ruby = spawnSync("ruby", ["-Eutf-8", "-rjson", "-e", "require ARGV[0]; cases = JSON.parse($stdin.read); print JSON.generate(cases.map { |base, candidate, separator| PathContainment.within?(base, candidate, separator) })", join(ROOT, "scripts", "path_containment.rb")], { input: JSON.stringify(cases), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert(ruby.status === 0, `the Ruby containment check did not run: ${ruby.stderr || ruby.error}`);
  const rubyResults = JSON.parse(ruby.stdout) as boolean[];
  cases.forEach(([base, candidate, separator], index) => {
    assert(rubyResults[index] === childWithin(base, candidate, separator), `scripts/path_containment.rb disagrees with the core (seed ${seed}): ${JSON.stringify([base, candidate, separator])}`);
  });

  // The wizard's guard resolves a request first; a relative-path reference must agree with it.
  // `..` followed by the root's own name plus "x" reaches a sibling that shares the root's
  // prefix, and one request in five starts that way.
  const root = join(tmpdir(), `agent-sync-no-such-root-${process.pid}`);
  const sibling = `${basename(root)}x`;
  const requestSegments = ["a", "b", "..", ".", "", "..a", "a..", "%2e%2e", "webx", sibling];
  let siblings = 0;
  for (let index = 0; index < 5_000; index += 1) {
    const segments = Array.from({ length: 1 + Math.floor(random() * 5) }, () => pick(requestSegments));
    const request = `/${(random() < 0.2 ? ["..", sibling, ...segments] : segments).join("/")}`;
    const resolved = resolve(root, request.replace(/^\/+/, ""));
    const rel = relative(resolve(root), resolved);
    const expected = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
    if (!expected && resolved.startsWith(resolve(root))) siblings += 1;
    assert((safeChildPath(root, request) !== null) === expected, `safeChildPath disagrees with the relative-path reference (seed ${seed}): ${request}`);
  }
  assert(siblings >= 500, `only ${siblings} generated wizard requests reached a sibling that shares the root's prefix`);
}

// The wizard serves only its own page. This enumerates request shapes and compares
// refusal() with the rule written out as plain sets, not with the same parsing.
function atlasBoundaryChecks(): void {
  const token = "T0k3n-for-tests-only_0123456789abcdefghijk";
  const loopback: Boundary = { port: 4321, bind: "127.0.0.1", allowRemote: false, token };
  const own = ["127.0.0.1:4321", "localhost:4321", "LocalHost:4321", "[::1]:4321"];
  const foreign = [undefined, "", "127.0.0.1", "127.0.0.1:4322", "localhost.:4321", "127.0.0.1.attacker.test:4321", "attacker.test:4321", "attacker.test@127.0.0.1:4321", "127.0.0.1:4321.attacker.test", "[::ffff:127.0.0.1]:4321", "0.0.0.0:4321", "192.168.1.20:4321"];
  const origins = ["absent", "same", "same-upper", "https", "other", "other-port", "null"] as const;
  const sites = [undefined, "same-origin", "none", "same-site", "cross-site"];
  const jsonTypes = ["application/json", "application/json; charset=utf-8"];
  const types = [undefined, ...jsonTypes, "text/plain", "application/x-www-form-urlencoded", "multipart/form-data", "application/jsonp"];
  const tokens = [undefined, token, `${token}x`, token.slice(1), ""];
  const requests = [["POST", "/api/action/backup"], ["POST", "/api/action/render"], ["GET", "/api/overview"], ["GET", "/api/check/fleet"], ["OPTIONS", "/api/action/backup"], ["GET", "/"], ["GET", "/docs/agent-atlas.md"]];
  let served = 0;
  let refused = 0;
  for (const host of [...own, ...foreign]) {
    for (const kind of origins) {
      const origin = { absent: undefined, same: `http://${host}`, "same-upper": `HTTP://${String(host).toUpperCase()}`, https: `https://${host}`, other: "http://attacker.test", "other-port": "http://127.0.0.1:1", null: "null" }[kind];
      const originOwn = kind === "same" || kind === "same-upper";
      for (const site of sites) for (const type of types) for (const sent of tokens) for (const [method, path] of requests) {
        const headers = Object.fromEntries(Object.entries({ host, origin, "sec-fetch-site": site, "content-type": type, [TOKEN_HEADER]: sent }).filter(([, value]) => value !== undefined)) as Record<string, string>;
        const notCrossOrigin = (kind === "absent" || originOwn) && (site === undefined || site === "same-origin" || site === "none");
        const action = method === "POST" && path.startsWith("/api/action/");
        const proof = (originOwn || site === "same-origin") && jsonTypes.includes(type ?? "") && sent === token;
        const expected = host !== undefined && own.includes(host) && (!path.startsWith("/api/") || (notCrossOrigin && (!action || proof)));
        const allowed = refusal(method, path, headers, loopback) === null;
        assert(allowed === expected, `the wizard ${allowed ? "serves" : "refuses"} ${method} ${path} with ${JSON.stringify(headers)}`);
        if (allowed) served += 1;
        else refused += 1;
      }
    }
  }
  assert(served > 1_000 && refused > 100_000, `the request enumeration is lopsided: ${served} served, ${refused} refused`);
  const remote: Boundary = { port: 4321, bind: "atlas.example", allowRemote: true, token };
  for (const host of ["127.0.0.1:4321", "192.168.1.20:4321", "[fd7a:115c:a1e0::1]:4321", "atlas.example:4321"]) assert(refusal("GET", "/", { host }, remote) === null, `--allow-remote refused ${host}`);
  for (const host of ["attacker.test:4321", "192.168.1.20:4322", "atlas.example.attacker.test:4321"]) assert(refusal("GET", "/", { host }, remote) !== null, `--allow-remote served ${host}`);
  assert(refusal("GET", "/", { host: "localhost" }, { ...loopback, port: 80 }) === null, "a Host without a port means port 80");
}

type RawRequest = { method?: string; path: string; headers?: Record<string, string>; body?: string };

// node:http, not fetch: a test must be able to send any Host and Origin.
function rawRequest(port: number, { method = "GET", path, headers = {}, body }: RawRequest): Promise<number> {
  return new Promise((resolveStatus, reject) => {
    const sent = httpRequest({ host: "127.0.0.1", port, method, path, headers: { ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }), ...headers } }, (response) => {
      response.resume();
      response.on("end", () => resolveStatus(response.statusCode ?? 0));
    });
    sent.on("error", reject);
    sent.end(body);
  });
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
  if (process.platform !== "win32") await heldOutputChecks();
  kvmChecks();
  itfChecks();
  specRegistryChecks();
  storeVerificationChecks();
  argumentAndPathChecks();
  await probeChecks();
  await workspaceProbeChecks();
  await checkRunnerChecks();
  await blockAndInitChecks();
  specCliChecks();
  encodingChecks();
  await redactionChecks();
  containmentChecks();
  containmentPropertyChecks();
  atlasBoundaryChecks();
  credentialScanChecks();
  redactConfigChecks();
  storeCommandChecks();
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
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const token = /<meta name="agent-atlas-token" content="([A-Za-z0-9_-]{43})" \/>/.exec(await page.text())?.[1] ?? "";
    assert(token !== "", "the wizard page carries no token");
    assert(page.headers.get("x-frame-options") === "DENY" && page.headers.get("content-security-policy") === "frame-ancestors 'none'", "another page can frame the wizard");
    const origin = `http://127.0.0.1:${port}`;
    const fromPage = { "content-type": "application/json", origin, [TOKEN_HEADER]: token };
    const backup = (headers: Record<string, string>, body = "{}") => rawRequest(port, { method: "POST", path: "/api/action/backup", headers, body });
    assert(await backup(fromPage) === 400, "backup action lost its confirmation guard");
    assert(await backup({ "content-type": "application/json", "sec-fetch-site": "same-origin", [TOKEN_HEADER]: token }) === 400, "Sec-Fetch-Site: same-origin was not accepted in place of Origin");
    // Each refused action sends confirm false, so a missing guard still runs nothing.
    const unconfirmed = JSON.stringify({ confirm: false });
    const attacks: Array<[string, number, Promise<number>]> = [
      ["a foreign Host", 403, rawRequest(port, { path: "/api/overview", headers: { host: `attacker.test:${port}` } })],
      ["a foreign Host for the page", 403, rawRequest(port, { path: "/", headers: { host: `attacker.test:${port}` } })],
      ["a cross-origin text/plain POST", 403, backup({ origin: "http://attacker.test", "content-type": "text/plain" }, unconfirmed)],
      ["a same-origin text/plain POST", 415, backup({ ...fromPage, "content-type": "text/plain" }, unconfirmed)],
      ["a POST without Origin or Sec-Fetch-Site", 403, backup({ "content-type": "application/json", [TOKEN_HEADER]: token }, unconfirmed)],
      ["a POST without the token", 403, backup({ "content-type": "application/json", origin }, unconfirmed)],
      ["a POST with a wrong token", 403, backup({ ...fromPage, [TOKEN_HEADER]: "0".repeat(43) }, unconfirmed)],
      ["a cross-site check", 403, rawRequest(port, { path: "/api/check/backup-plan", headers: { "sec-fetch-site": "cross-site" } })],
      ["a cross-origin preflight", 403, rawRequest(port, { method: "OPTIONS", path: "/api/action/backup", headers: { origin: "http://attacker.test" } })],
    ];
    for (const [name, expected, status] of attacks) assert(await status === expected, `${name} got ${await status}, not ${expected}`);
    const unknownCheck = await fetch(`http://127.0.0.1:${port}/api/check/unknown`);
    const unknownPayload = await unknownCheck.json() as any;
    assert(unknownCheck.status === 503 && unknownPayload.status === "error", "failed checks did not return a failing HTTP status");
    // fetch, because it reads an early 413 while the body is still being sent.
    const oversized = await fetch(`${origin}/api/action/backup`, { method: "POST", headers: fromPage, body: JSON.stringify({ confirm: true, padding: "x".repeat(70_000) }) });
    assert(oversized.status === 413, "action body limit did not fail closed");
  } finally {
    child.kill("SIGTERM");
  }
  console.log("CI Agent Sync TypeScript checks passed");
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
