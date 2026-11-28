#!/usr/bin/env node

// npm run spec:containment
//
// Proves the LemmaScript contracts in the files that LemmaScript-files.txt lists
// (today src/path-containment.ts) with Dafny, then fails if the generated Dafny
// differs from HEAD. It needs the pinned lemmascript from `npm ci` and Dafny
// 4.11.0, found through the DAFNY environment variable (the path of the dafny
// executable) or on PATH. A missing or different Dafny fails the check: it never
// skips. Dafny runs with the type-system options that Dafny's main branch has
// made the default, so a release that includes them cannot change what the proof
// means.
//
// Before and after the proof it closes the ways a run can pass without proving
// anything: a misspelled annotation (unread-annotations must be "error", and
// neither a listed file nor a nearer lemmascript.json may change that or any other
// option), Dafny flags or a long timeout in LemmaScript-files.txt (batch mode only
// generates such entries), an escape-hatch annotation, an `include` (dafny audit
// does not look inside one), an assumption that dafny audit reports, and a file
// that Dafny did not verify.
//
// Last, it plants faults in scratch copies of the proof files, one fault per copy:
// a weakened function body, and one for each of the ways above. Each must fail
// this check with the expected message, so a guard that stops working fails the
// run. --proof-only skips this step; the planted runs use it.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAFNY_VERSION = "4.11.0";
const LSC_VERSION = "0.6.14";
// Dafny's main branch makes these the default type system (dafny-lang/dafny#6432,
// not in a release yet).
const DAFNY_FLAGS = ["--type-system-refresh", "--general-traits=datatype", "--general-newtypes"];
// Annotations that give the prover a fact without a proof, or leave code out of it.
const ESCAPE_HATCH = /\/\/@\s*(assume|havoc|autohavoc|extern|impure|declare-type|type|skip)\b/;
// A file can set LemmaScript options itself, with `//@ option <key> <value>` or the
// older `//@ safe-slice`. Options belong in lemmascript.json, where this check reads them.
const OPTION_DIRECTIVE = /\/\/@\s*(option|safe-slice)\b/;
const proofOnly = process.argv.includes("--proof-only");

function fail(message) {
  console.error(`spec:containment: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  return result;
}

function echo(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

function executable(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function findDafny() {
  if (process.env.DAFNY) {
    const path = resolve(process.env.DAFNY);
    if (!executable(path)) fail(`DAFNY is set to ${process.env.DAFNY}, which is not an executable file`);
    return path;
  }
  const names = process.platform === "win32" ? ["dafny.exe", "dafny.cmd"] : ["dafny"];
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    for (const name of names) if (executable(join(directory, name))) return join(directory, name);
  }
  fail(`Dafny ${DAFNY_VERSION} was not found. Set DAFNY to the dafny executable from the ${DAFNY_VERSION} release, or put its folder on PATH. This check does not skip without it.`);
}

const dafny = findDafny();
const dafnyVersion = run(dafny, ["--version"]).stdout.trim();
if (dafnyVersion !== DAFNY_VERSION && !dafnyVersion.startsWith(`${DAFNY_VERSION}+`)) {
  fail(`${dafny} reports Dafny ${dafnyVersion || "(no version)"}; this check needs ${DAFNY_VERSION}`);
}

const lscManifestPath = join(ROOT, "node_modules", "lemmascript", "package.json");
if (!existsSync(lscManifestPath)) fail("lemmascript is not installed; run npm ci");
const lscManifest = JSON.parse(readFileSync(lscManifestPath, "utf8"));
if (lscManifest.version !== LSC_VERSION) fail(`lemmascript ${lscManifest.version} is installed; this check needs ${LSC_VERSION} (run npm ci)`);
const lsc = join(dirname(lscManifestPath), lscManifest.bin.lsc);

const config = JSON.parse(readFileSync(join(ROOT, "lemmascript.json"), "utf8"));
if (config["unread-annotations"] !== "error") {
  fail('lemmascript.json must set "unread-annotations": "error"; otherwise a misspelled annotation passes as 0 verified');
}
if (config["proof-dir"] !== undefined) fail("lemmascript.json sets proof-dir; this check expects each .dfy beside its .ts");

// lsc reads every non-empty line as `path [timeout] [dafny flags...]`.
const entries = readFileSync(join(ROOT, "LemmaScript-files.txt"), "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
if (entries.length === 0) fail("LemmaScript-files.txt lists no files");
const files = entries.map((entry) => {
  const [file, timeout, ...rest] = entry.split(/\s+/);
  if (rest.length > 0 || (timeout !== undefined && !/^[1-9]\d*$/.test(timeout))) {
    fail(`LemmaScript-files.txt: "${entry}" passes Dafny flags, which can turn proofs off; this check accepts a path and an optional timeout`);
  }
  if (timeout !== undefined && Number(timeout) > 60) fail(`LemmaScript-files.txt: "${entry}" has a timeout over 60 seconds; lsc batch mode would only generate it, not verify it`);
  if (!file.endsWith(".ts") || !existsSync(join(ROOT, file))) fail(`LemmaScript-files.txt lists ${file}, which is not a TypeScript file in this repository`);
  return file;
});

for (const file of files) {
  const lines = readFileSync(join(ROOT, file), "utf8").split("\n");
  const hatch = lines.findIndex((line) => ESCAPE_HATCH.test(line));
  if (hatch >= 0) fail(`${file}:${hatch + 1} uses an escape-hatch annotation (${lines[hatch].trim()}); that needs the owner's review, and this check does not accept it`);
  const option = lines.findIndex((line) => OPTION_DIRECTIVE.test(line));
  if (option >= 0) fail(`${file}:${option + 1} sets a LemmaScript option in the file (${lines[option].trim()}); set options in lemmascript.json, where this check reads them`);
  const proof = file.replace(/\.ts$/, ".dfy");
  if (existsSync(join(ROOT, proof))) {
    const include = readFileSync(join(ROOT, proof), "utf8").split("\n").findIndex((line) => /^\s*include\b/.test(line));
    if (include >= 0) fail(`${proof}:${include + 1} includes another Dafny file; dafny audit does not look inside includes, so this check does not accept them`);
  }
}

// lsc reads options from the lemmascript.json nearest each file, then from the file
// itself, so ask lsc what it will use: every listed file must get exactly the options
// of this repository's lemmascript.json.
function lscConfig(file) {
  const result = run(process.execPath, [lsc, "config", ...(file ? [file] : [])]);
  if (result.status !== 0) {
    echo(result);
    fail(`lsc config ${file || "(for the repository)"} failed (exit ${result.status})`);
  }
  return JSON.parse(result.stdout);
}
const configFile = realpathSync(join(ROOT, "lemmascript.json"));
const project = lscConfig();
if (!project.configFile || realpathSync(project.configFile) !== configFile) fail(`lsc reads its options from ${project.configFile}, not lemmascript.json`);
if (project.options["unread-annotations"] !== "error") fail(`lsc resolves unread-annotations to "${project.options["unread-annotations"]}"; this check needs "error"`);
for (const file of files) {
  const effective = lscConfig(file);
  if (!effective.configFile || realpathSync(effective.configFile) !== configFile) {
    fail(`${file} reads its LemmaScript options from ${effective.configFile ? relative(realpathSync(ROOT), realpathSync(effective.configFile)) : "no lemmascript.json"}, not lemmascript.json; remove the nearer file`);
  }
  for (const key of new Set([...Object.keys(project.options), ...Object.keys(effective.options)])) {
    if (effective.options[key] !== project.options[key]) fail(`${file} changes the LemmaScript option ${key} to ${JSON.stringify(effective.options[key])}; set options in lemmascript.json instead`);
  }
}

// --slow makes batch mode verify every entry, whatever its timeout.
const env = { ...process.env, PATH: `${dirname(dafny)}${delimiter}${process.env.PATH || ""}` };
const check = run(process.execPath, [lsc, "check", "--backend=dafny", "--slow", `--extra-flags=${DAFNY_FLAGS.join(" ")}`], { env });
echo(check);
if (check.status !== 0) fail(`lsc check failed (exit ${check.status})`);
const summaries = [...check.stdout.matchAll(/Dafny program verifier finished with (\d+) verified, (\d+) errors?/g)];
if (summaries.length !== files.length || summaries.some((summary) => Number(summary[1]) === 0 || Number(summary[2]) !== 0)) {
  fail(`expected a passing Dafny run with at least one verified item for each of the ${files.length} listed files; got ${summaries.length ? summaries.map((summary) => summary[0]).join("; ") : "none"}`);
}

for (const file of files) {
  const proof = file.replace(/\.ts$/, ".dfy");
  const utf16 = readFileSync(join(ROOT, proof), "utf8").includes("string-semantics=javascript-utf16");
  const audit = run(dafny, ["audit", ...(utf16 ? ["--unicode-char:false", "--allow-deprecation"] : ["--unicode-char:true"]), ...DAFNY_FLAGS, proof]);
  const findings = /Dafny auditor completed with (\d+) findings?/.exec(audit.stdout);
  if (audit.status !== 0 || !findings || Number(findings[1]) !== 0) {
    echo(audit);
    fail(`dafny audit reports assumptions or axioms in ${proof}; prove them instead`);
  }
}

const diff = run("git", ["diff", "--exit-code", "--stat", "HEAD", "--", "*.dfy.gen", "*.dfy"]);
if (diff.status === 1) {
  echo(diff);
  fail("the generated Dafny differs from HEAD; if the TypeScript changed on purpose, run lsc regen and commit the .dfy.gen and .dfy files");
}
if (diff.status !== 0) {
  echo(diff);
  fail(`could not compare the generated Dafny with HEAD (git exit ${diff.status})`);
}
const untracked = run("git", ["ls-files", "--others", "--exclude-standard", "--", "*.dfy.gen", "*.dfy"]).stdout.trim();
if (untracked) fail(`generated Dafny is not committed: ${untracked.split("\n").join(", ")}`);

const proved = `${files.length} file(s) proved with Dafny ${DAFNY_VERSION} and lsc ${LSC_VERSION}; dafny audit reported no assumptions; the generated Dafny matches HEAD`;
if (proofOnly) {
  console.log(`spec:containment: ${proved}`);
  process.exit(0);
}

// Planted faults. Each one edits a scratch git repository that holds a copy of the proof
// files and this script, and this check must then fail there with the expected text.
// Every edit must change the file it names, so a fault that no longer matches the code
// fails the run instead of passing without being planted.
const CORE = "src/path-containment.ts";
const CORE_PROOF = "src/path-containment.dfy";
const BODY = "return candidate === base || candidate.startsWith(base + sep);";
const misspell = (text) => text.replace(`  ${BODY}`, `  //@ ensure \\result ==> candidate.length >= base.length\n  ${BODY}`);
const PLANTED = [
  {
    fault: "a weakened function body, with its Dafny regenerated and committed",
    edits: { [CORE]: (text) => text.replace(BODY, "return candidate === base || candidate.startsWith(base);") },
    regenerate: true,
    expect: "a postcondition could not be proved",
  },
  { fault: "a misspelled annotation", edits: { [CORE]: misspell }, expect: "lsc does not read this annotation" },
  {
    fault: "a misspelled annotation under an option line that turns the annotation check off",
    edits: { [CORE]: (text) => misspell(text).replace("//@ backend dafny\n", "//@ backend dafny\n//@ option unread-annotations off\n") },
    expect: "sets a LemmaScript option",
  },
  {
    fault: "a misspelled annotation beside a nearer lemmascript.json that turns the annotation check off",
    edits: { [CORE]: misspell, "src/lemmascript.json": () => `${JSON.stringify({ ...config, "unread-annotations": "off" })}\n` },
    expect: "reads its LemmaScript options from src/lemmascript.json",
  },
  {
    fault: "Dafny flags in LemmaScript-files.txt",
    edits: { "LemmaScript-files.txt": (text) => text.replace(CORE, `${CORE} 30 --filter-symbol=NoSuchSymbol`) },
    expect: "passes Dafny flags",
  },
  {
    fault: "an escape-hatch annotation",
    edits: { [CORE]: (text) => text.replace(`  ${BODY}`, `  //@ assume base.length > 0\n  ${BODY}`) },
    expect: "uses an escape-hatch annotation",
  },
  { fault: "an include in the proof", edits: { [CORE_PROOF]: (text) => `include "axioms.dfy"\n${text}` }, expect: "includes another Dafny file" },
  {
    fault: "an assumption in the proof",
    edits: { [CORE_PROOF]: (text) => text.replace(/\{\n\}\n?$/, "{\n  assume false;\n}\n") },
    expect: "assume statements are not allowed in proof additions",
  },
  {
    fault: "a call into a file that is not listed, which lsc models as an axiom",
    edits: {
      "src/path-containment-callee.ts": () => "export function same(value: boolean): boolean {\n  //@ ensures \\result === value\n  return value;\n}\n",
      [CORE]: (text) => text
        .replace("//@ backend dafny\n", '//@ backend dafny\nimport { same } from "./path-containment-callee.ts";\n')
        .replace(BODY, "return same(candidate === base || candidate.startsWith(base + sep));"),
    },
    regenerate: true,
    expect: "dafny audit reports assumptions or axioms",
  },
  {
    fault: "a backend line that makes lsc skip the file",
    edits: { [CORE]: (text) => text.replace("//@ backend dafny", "//@ backend lean") },
    expect: "expected a passing Dafny run",
  },
];

const copies = new Set();
process.on("exit", () => {
  for (const copy of copies) rmSync(copy, { recursive: true, force: true });
});

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=spec-containment", "-c", "user.email=spec-containment@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.error || result.status !== 0) fail(`git ${args.join(" ")} failed in a planted copy: ${result.stderr || result.error}`);
}

function plantedCopy() {
  const copy = realpathSync(mkdtempSync(join(tmpdir(), "spec-containment-")));
  copies.add(copy);
  const sources = ["lemmascript.json", "LemmaScript-files.txt", "tsconfig.json", "scripts/spec-containment.mjs"];
  for (const file of files) sources.push(file, file.replace(/\.ts$/, ".dfy"), file.replace(/\.ts$/, ".dfy.gen"));
  for (const source of sources) {
    mkdirSync(dirname(join(copy, source)), { recursive: true });
    cpSync(join(ROOT, source), join(copy, source));
  }
  symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"));
  writeFileSync(join(copy, ".gitignore"), "node_modules\n");
  git(copy, "init", "-q");
  git(copy, "add", "-A");
  git(copy, "commit", "-q", "--no-verify", "-m", "proof files");
  return copy;
}

// The output of a child process, without blocking, so that planted runs overlap.
function spawnOutput(command, args, cwd) {
  return new Promise((done) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.on("error", (error) => done({ status: null, output: `${output}${error.message}\n` }));
    child.on("close", (status) => done({ status, output }));
  });
}

// Plants one fault and returns why it did not fail the check as expected, or null.
async function plant({ fault, edits, regenerate, expect }) {
  const copy = plantedCopy();
  for (const [file, edit] of Object.entries(edits)) {
    const path = join(copy, file);
    const before = existsSync(path) ? readFileSync(path, "utf8") : null;
    const after = edit(before ?? "");
    if (after === before) fail(`the planted fault "${fault}" no longer changes ${file}; update it to match the code`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, after);
  }
  if (regenerate) {
    for (const suffix of [".dfy", ".dfy.gen"]) rmSync(join(copy, CORE.replace(/\.ts$/, suffix)));
    const gen = await spawnOutput(process.execPath, [lsc, "gen", CORE], copy);
    if (gen.status !== 0) return { problem: `could not be set up: lsc gen exited ${gen.status}`, output: gen.output };
  }
  git(copy, "add", "-A");
  git(copy, "commit", "-q", "--no-verify", "-m", "planted fault");
  const result = await spawnOutput(process.execPath, [join(copy, "scripts", "spec-containment.mjs"), "--proof-only"], copy);
  rmSync(copy, { recursive: true, force: true });
  copies.delete(copy);
  if (result.status !== 1 || !result.output.includes(expect)) return { problem: `did not fail this check with "${expect}" (exit ${result.status})`, output: result.output };
  return null;
}

const queue = PLANTED.map((planted, index) => ({ planted, index }));
const problems = [];
await Promise.all(Array.from({ length: Math.min(4, availableParallelism(), queue.length) }, async () => {
  for (let next = queue.shift(); next; next = queue.shift()) {
    const problem = await plant(next.planted);
    if (problem) problems.push({ ...problem, index: next.index });
  }
}));
for (const { index, problem, output } of problems.sort((a, b) => a.index - b.index)) {
  process.stdout.write(output);
  console.error(`spec:containment: the planted fault "${PLANTED[index].fault}" ${problem}`);
}
if (problems.length > 0) process.exit(1);

console.log(`spec:containment: ${proved}; each of the ${PLANTED.length} planted faults failed the check as expected`);
