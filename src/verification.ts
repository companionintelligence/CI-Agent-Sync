// `agentctl spec`: the spec registry commands.
//
//   toolchains  probe the tools in integrations/verification/toolchains.yaml
//   validate    decode a repository's .agent-configs/specs.toml and check its paths
//   list        show the registry's entries
//   check       run each entry's check, without a shell, with bounded child processes
//   init        print the registry template, or write it with --apply when absent
//   block       render the managed AGENTS.md / CLAUDE.md section from the registry
//   schema      print, write or check integrations/verification/specs.schema.json
//
// Every subcommand takes --json and then prints the standard envelope
// {schema_version, summary, checks}. Nothing is written without --apply or --write, and
// nothing is written outside the repository, even through a symlink.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { ROOT, readText, readYaml, runCommand, runCommandAsync, safeDetail } from "./core.ts";
import {
  DEFAULT_TIMEOUT_SECONDS,
  REGISTRY_FILE,
  SCHEMA_FILE,
  SPEC_TOOLS,
  entryGate,
  parseRegistry,
  renderRegistryJsonSchema,
  type DecodeResult,
  type SpecEntry,
  type SpecRegistry,
} from "./spec-registry.ts";
import { DEFAULT_PROBE_TIMEOUT_MS, POLICY_FILE, TOOLCHAINS_FILE, displayPath, hideHome, locateProbe, probeToolchain, readToolchains, toolchainEnvironment, type ProbeResult, type Toolchain } from "./toolchains.ts";

export const TEMPLATE_FILE = "integrations/verification/specs.toml.example";
export const BLOCK_BEGIN = "<!-- agent-sync:specs:begin -->";
export const BLOCK_END = "<!-- agent-sync:specs:end -->";
export const BLOCK_FILES = ["AGENTS.md", "CLAUDE.md"] as const;
const REPO_URL = "https://github.com/companionintelligence/CI-Agent-Sync";
const CHECK_OUTPUT_LIMIT = 8 * 1024 * 1024;

export type Status = "ok" | "warn" | "error" | "info" | "skipped" | "not-installed";
export type Check = { id: string; status: Status; detail: string; [key: string]: unknown };

/** The standard envelope: {schema_version, summary, checks}, plus any extra fields. */
export function envelope(checks: ReadonlyArray<Check>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const summary: Record<string, number> = { ok: 0, warn: 0, error: 0 };
  for (const check of checks) summary[check.status] = (summary[check.status] ?? 0) + 1;
  return { schema_version: 1, summary, checks, ...extra };
}

const ICON: Record<Status, string> = { ok: "✓", warn: "!", error: "✗", info: "·", skipped: "-", "not-installed": "-" };

function report(checks: ReadonlyArray<Check>, options: { json: boolean; title: string; extra?: Record<string, unknown> }): number {
  const result = envelope(checks, options.extra);
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const check of checks) console.log(`${ICON[check.status]} ${check.id}: ${check.detail}`);
    const summary = result.summary as Record<string, number>;
    console.log(`${options.title}: ${Object.entries(summary).map(([status, count]) => `${count} ${status}`).join(", ")}`);
  }
  return checks.some((check) => check.status === "error") ? 1 : 0;
}

// ── arguments ───────────────────────────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set(["--json", "--apply", "--check", "--write"]);
const VALUE_FLAGS = new Set(["--repo", "--only", "--tool", "--changed-from", "--timeout", "--name"]);

export type SpecArgs = { flags: Set<string>; values: Map<string, string[]>; positional: string[]; problems: string[] };

/**
 * Parse `agentctl spec` options. A boolean flag never takes the next token as its value,
 * and `--key=value` keeps everything after the first `=`.
 */
export function parseSpecArgs(args: ReadonlyArray<string>): SpecArgs {
  const parsed: SpecArgs = { flags: new Set(), values: new Map(), positional: [], problems: [] };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith("--")) {
      parsed.positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const key = equals === -1 ? token : token.slice(0, equals);
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    if (BOOLEAN_FLAGS.has(key)) {
      if (inline !== undefined) parsed.problems.push(`${key} takes no value`);
      parsed.flags.add(key);
    } else if (VALUE_FLAGS.has(key)) {
      const value = inline ?? args[index + 1];
      if (inline === undefined) index += 1;
      if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) {
        parsed.problems.push(`${key} needs a value`);
        if (inline === undefined && value !== undefined && value.startsWith("--")) index -= 1;
        continue;
      }
      parsed.values.set(key, [...(parsed.values.get(key) || []), value]);
    } else {
      parsed.problems.push(`unknown option ${key}`);
    }
  }
  return parsed;
}

/** Comma-separated and repeated values of one option, in order, without blanks. */
function listValue(args: SpecArgs, key: string): string[] {
  return (args.values.get(key) || []).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
}

function lastValue(args: SpecArgs, key: string): string | undefined {
  return args.values.get(key)?.at(-1);
}

// ── paths ───────────────────────────────────────────────────────────────────────────

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where `relativePath` really is, provided it stays inside the repository. A path that
 * leaves it through `..`, through a symlinked file or directory, or through a dangling
 * symlink is refused, so a write can never land outside the repository.
 */
export function resolveInsideRepo(repo: string, relativePath: string): { real: string; exists: boolean } | { error: string } {
  let root: string;
  try {
    root = realpathSync(repo);
  } catch {
    return { error: `${displayPath(repo)} does not exist` };
  }
  const target = resolve(root, relativePath);
  if (!within(root, target)) return { error: `${relativePath} is outside the repository` };
  let probe = target;
  while (!lexists(probe)) probe = dirname(probe);
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    return { error: `${relative(root, probe) || "."} is a dangling symlink` };
  }
  if (!within(root, real)) return { error: `${relative(root, probe) || "."} resolves outside the repository` };
  const exists = probe === target;
  return { real: exists ? real : join(real, relative(probe, target)), exists };
}

function repoOption(args: SpecArgs): string {
  return resolve(lastValue(args, "--repo") || process.cwd());
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directories whose node_modules an entry's toolchains are looked for in, most
 * specific first: the entry's workdir, then the directory of each artefacts and covers
 * path, each walking up towards the repository root, then the root itself. A path that is
 * a directory counts from itself, and a glob from the part before its first wildcard. A
 * directory that does not exist, or that a symlink takes outside the repository, is left
 * out, so the lookup never leaves the repository.
 */
export function probeDirs(repo: string, entry: Pick<SpecEntry, "workdir" | "artefacts" | "covers">): string[] {
  let root: string;
  try {
    root = realpathSync(repo);
  } catch {
    return [resolve(repo)];
  }
  const dirs: string[] = [];
  const seen = new Set([root]);
  for (const path of [...(entry.workdir === undefined ? [] : [entry.workdir]), ...(entry.artefacts ?? []), ...(entry.covers ?? [])]) {
    const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
    const wildcard = segments.findIndex((segment) => /[*?]/u.test(segment));
    let parts = wildcard === -1 ? segments : segments.slice(0, wildcard);
    if (wildcard === -1 && !isDirectory(join(root, ...parts))) parts = parts.slice(0, -1);
    for (; parts.length > 0; parts = parts.slice(0, -1)) {
      const dir = join(root, ...parts);
      let real: string;
      try {
        real = realpathSync(dir);
      } catch {
        continue;
      }
      if (!within(root, real) || seen.has(real)) continue;
      seen.add(real);
      dirs.push(dir);
    }
  }
  return [...dirs, root];
}

// ── registry and toolchains ─────────────────────────────────────────────────────────

export type LoadedRegistry = { file: string; decoded: DecodeResult } | { file: string; missing: true };

export function loadRegistry(repo: string): LoadedRegistry {
  const file = join(repo, REGISTRY_FILE);
  if (!existsSync(file)) return { file, missing: true };
  return { file, decoded: parseRegistry(readFileSync(file, "utf8")) };
}

function registryChecks(loaded: LoadedRegistry): { checks: Check[]; registry?: SpecRegistry } {
  if ("missing" in loaded) return { checks: [{ id: "registry", status: "error", detail: `no registry at ${displayPath(loaded.file)}; run agentctl spec init` }] };
  if (!loaded.decoded.ok) {
    return { checks: loaded.decoded.issues.map((issue) => ({ id: `registry.${issue.path || "file"}`, status: "error", detail: issue.message })) };
  }
  const entries = loaded.decoded.registry.spec ?? [];
  const planned = entries.filter((entry) => entry.status === "planned").length;
  return {
    checks: [{ id: "registry", status: "ok", detail: `${REGISTRY_FILE} decodes: ${entries.length} ${entries.length === 1 ? "entry" : "entries"}, ${planned} planned` }],
    registry: loaded.decoded.registry,
  };
}

export function loadToolchains(): { toolchains: Toolchain[]; checks: Check[] } {
  try {
    const { toolchains, problems } = readToolchains(readYaml(TOOLCHAINS_FILE), SPEC_TOOLS);
    return { toolchains, checks: problems.map((problem) => ({ id: `toolchains.${problem.id}`, status: "error", detail: problem.message })) };
  } catch (error) {
    return { toolchains: [], checks: [{ id: "toolchains", status: "error", detail: `could not read ${TOOLCHAINS_FILE}: ${String(error)}` }] };
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  return { GIT_OPTIONAL_LOCKS: "0" };
}

/** Files tracked by git in `repo`, or undefined when it is not a git checkout. */
function trackedFiles(repo: string): string[] | undefined {
  const result = runCommand("git", ["-C", repo, "ls-files", "-z"], { env: gitEnv(), timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024 });
  return result.exitCode === 0 ? result.stdout.split("\0").filter(Boolean) : undefined;
}

// ── globs ───────────────────────────────────────────────────────────────────────────

/** A covers pattern as a RegExp: `**` spans directories, `*` and `?` stay inside one. */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      const slash = pattern[index + 2] === "/";
      source += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

/** Does `file` fall under `pattern`: a glob, an exact path, or a directory prefix? */
export function matchesPattern(file: string, pattern: string): boolean {
  if (/[*?]/u.test(pattern)) return globToRegExp(pattern).test(file);
  const path = pattern.replace(/\/+$/u, "");
  return file === path || file.startsWith(`${path}/`);
}

// Files that can change what a check runs without touching its covers or artefacts: the
// package manifest names the script, and a lockfile pins the tool.
const PACKAGE_FILES = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];

/** A repo-relative directory without `.` segments or a trailing slash; "" for the root. */
function normalDir(path: string): string {
  return path.split("/").filter((segment) => segment !== "" && segment !== ".").join("/");
}

/**
 * The entries a change touches. A change to the registry touches every entry, since it may
 * edit a check, a bound, a gate or a status. Otherwise an entry is touched when a changed
 * file matches its covers or artefacts, or, for an entry with a check, the package manifest
 * or a lockfile at the root or in its workdir.
 */
export function entriesTouchedBy(entries: ReadonlyArray<SpecEntry>, files: ReadonlyArray<string>): SpecEntry[] {
  if (files.includes(REGISTRY_FILE)) return [...entries];
  return entries.filter((entry) => {
    const dirs = entry.check === undefined ? [] : [...new Set(["", normalDir(entry.workdir ?? "")])];
    const packageFiles = dirs.flatMap((dir) => PACKAGE_FILES.map((name) => (dir === "" ? name : `${dir}/${name}`)));
    return [...(entry.covers ?? []), ...(entry.artefacts ?? []), ...packageFiles].some((pattern) => files.some((file) => matchesPattern(file, pattern)));
  });
}

/** `git diff --name-only REF...HEAD` in `repo`, without taking optional locks. */
export function changedFiles(repo: string, ref: string): { files: string[] } | { error: string } {
  if (ref.startsWith("-")) return { error: `--changed-from ${ref} is not a ref` };
  const result = runCommand("git", ["-C", repo, "diff", "--name-only", "-z", `${ref}...HEAD`, "--"], { env: gitEnv(), timeoutMs: 30_000, maxBuffer: 64 * 1024 * 1024 });
  if (result.exitCode !== 0) return { error: `git diff ${ref}...HEAD failed: ${safeDetail(result.stderr || result.stdout || result.errorCode || "no output")}` };
  return { files: result.stdout.split("\0").filter(Boolean) };
}

// ── toolchains ──────────────────────────────────────────────────────────────────────

/**
 * The toolchains outside hold that provide an entry's tool, and a warning when `requires`
 * names none of them: then the tool is not probed before the check runs.
 */
function toolProviders(entry: SpecEntry, toolchains: ReadonlyArray<Toolchain>): { providers: Toolchain[]; warning?: Check } {
  const providers = toolchains.filter((toolchain) => toolchain.ring !== "hold" && toolchain.provides.includes(entry.tool));
  if (providers.length === 0 || providers.some((toolchain) => (entry.requires ?? []).includes(toolchain.id))) return { providers };
  const names = providers.map((toolchain) => `"${toolchain.id}"`).join(" or ");
  return { providers, warning: { id: `spec.${entry.id}.requires`, status: "warn", detail: `names no toolchain that provides ${entry.tool}, so it is not probed before the check runs; add ${names}` } };
}

async function mapLimited<T, R>(items: ReadonlyArray<T>, limit: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function toolchainsChecks(options: { repo: string; only?: ReadonlyArray<string>; timeoutMs?: number; toolchains?: ReadonlyArray<Toolchain> }): Promise<Check[]> {
  const loaded = options.toolchains ? { toolchains: [...options.toolchains], checks: [] as Check[] } : loadToolchains();
  const checks = [...loaded.checks];
  const unknown = (options.only || []).filter((id) => !loaded.toolchains.some((toolchain) => toolchain.id === id));
  for (const id of unknown) checks.push({ id: `toolchain.${id}`, status: "error", detail: "not in toolchains.yaml" });
  const selected = loaded.toolchains.filter((toolchain) => !options.only?.length || options.only.includes(toolchain.id));
  const probes = await mapLimited(selected, 4, (toolchain) => probeToolchain(toolchain, { repo: options.repo, timeoutMs: options.timeoutMs }));
  for (const [index, probe] of probes.entries()) {
    const toolchain = selected[index];
    checks.push({
      id: `toolchain.${probe.id}`,
      status: probe.status,
      detail: probe.detail,
      ring: toolchain.ring,
      ...(toolchain.version ? { pinned: toolchain.version } : {}),
      ...(toolchain.minimum ? { minimum: toolchain.minimum } : {}),
      ...(probe.version ? { version: probe.version } : {}),
      provides: toolchain.provides,
    });
  }
  return checks;
}

// ── validate and list ───────────────────────────────────────────────────────────────

export function validateChecks(repo: string, options: { toolchains?: ReadonlyArray<Toolchain> } = {}): Check[] {
  const { checks, registry } = registryChecks(loadRegistry(repo));
  if (!registry) return checks;
  const loaded = options.toolchains ? { toolchains: [...options.toolchains], checks: [] as Check[] } : loadToolchains();
  checks.push(...loaded.checks);
  const known = new Set(loaded.toolchains.map((toolchain) => toolchain.id));
  const tracked = trackedFiles(repo);
  if (tracked === undefined) checks.push({ id: "covers", status: "info", detail: "not a git checkout, so covers patterns were not matched against tracked files" });
  for (const entry of registry.spec ?? []) {
    const planned = entry.status === "planned";
    for (const id of entry.requires ?? []) {
      if (!known.has(id)) checks.push({ id: `spec.${entry.id}.requires.${id}`, status: "error", detail: `"${id}" is not a toolchain in CI-Agent-Sync's ${TOOLCHAINS_FILE}` });
    }
    // A planned entry has no check yet, so there is nothing to probe for.
    const { warning } = toolProviders(entry, loaded.toolchains);
    if (warning && !planned) checks.push(warning);
    for (const artefact of entry.artefacts ?? []) {
      const where = resolveInsideRepo(repo, artefact);
      if ("error" in where) checks.push({ id: `spec.${entry.id}.artefact.${artefact}`, status: "error", detail: where.error });
      else if (!where.exists) checks.push({ id: `spec.${entry.id}.artefact.${artefact}`, status: planned ? "info" : "error", detail: planned ? "planned, not written yet" : "missing" });
      else checks.push({ id: `spec.${entry.id}.artefact.${artefact}`, status: "ok", detail: "exists" });
    }
    if (entry.workdir !== undefined) {
      const where = resolveInsideRepo(repo, entry.workdir);
      const isDirectory = !("error" in where) && where.exists && statSync(where.real).isDirectory();
      checks.push({ id: `spec.${entry.id}.workdir`, status: isDirectory ? "ok" : planned ? "info" : "error", detail: "error" in where ? where.error : isDirectory ? "exists" : "is not a directory in the repository" });
    }
    if (tracked !== undefined) {
      for (const pattern of entry.covers ?? []) {
        const matched = tracked.some((file) => matchesPattern(file, pattern));
        if (!matched) checks.push({ id: `spec.${entry.id}.covers.${pattern}`, status: "warn", detail: "matches no tracked file" });
      }
    }
  }
  return checks;
}

function listChecks(repo: string): Check[] {
  const { checks, registry } = registryChecks(loadRegistry(repo));
  if (!registry) return checks;
  return (registry.spec ?? []).map((entry) => ({
    id: `spec.${entry.id}`,
    status: "info" as const,
    detail: `${entry.tool}, ${entry.status}, ${entryGate(entry)}${entry.check ? `: ${entry.check.join(" ")}` : ""}`,
    title: entry.title,
    kind: entry.kind,
    tool: entry.tool,
    entry_status: entry.status,
    gate: entryGate(entry),
    ...(entry.target ? { target: entry.target } : {}),
    ...(entry.check ? { check: entry.check } : {}),
  }));
}

// ── check ───────────────────────────────────────────────────────────────────────────

export type CheckOptions = {
  repo: string;
  only?: ReadonlyArray<string>;
  tools?: ReadonlyArray<string>;
  changedFrom?: string;
  /** Override the toolchains (tests use this); otherwise toolchains.yaml is read. */
  toolchains?: ReadonlyArray<Toolchain>;
  probeTimeoutMs?: number;
};

function fails(entry: SpecEntry): "error" | "warn" {
  return entryGate(entry) === "required" && (entry.status === "checked" || entry.status === "conformance") ? "error" : "warn";
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Run the selected entries' checks. A planned or unrun entry is never reported as ok. */
export async function checkEntries(options: CheckOptions): Promise<{ checks: Check[]; selection: Record<string, unknown> }> {
  const { checks: loadedChecks, registry } = registryChecks(loadRegistry(options.repo));
  if (!registry) return { checks: loadedChecks, selection: {} };
  const loaded = options.toolchains ? { toolchains: [...options.toolchains], checks: [] as Check[] } : loadToolchains();
  const checks: Check[] = [...loaded.checks];
  const entries = registry.spec ?? [];
  const only = options.only ?? [];
  const tools = options.tools ?? [];
  for (const id of only) if (!entries.some((entry) => entry.id === id)) checks.push({ id: `selection.only.${id}`, status: "error", detail: "no registry entry has this id" });
  for (const tool of tools) if (!(SPEC_TOOLS as ReadonlyArray<string>).includes(tool)) checks.push({ id: `selection.tool.${tool}`, status: "error", detail: `not a registry tool; use one of ${SPEC_TOOLS.join(", ")}` });
  let selected = entries.filter((entry) => (only.length === 0 || only.includes(entry.id)) && (tools.length === 0 || tools.includes(entry.tool)));
  const selection: Record<string, unknown> = { only, tools };
  if (options.changedFrom !== undefined) {
    const changed = changedFiles(options.repo, options.changedFrom);
    if ("error" in changed) {
      checks.push({ id: "selection.changed-from", status: "error", detail: changed.error });
      return { checks, selection: { ...selection, changed_from: options.changedFrom } };
    }
    selected = entriesTouchedBy(selected, changed.files);
    Object.assign(selection, { changed_from: options.changedFrom, changed_files: changed.files.length, ...(changed.files.includes(REGISTRY_FILE) ? { registry_changed: true } : {}) });
  }
  if (selected.length === 0) checks.push({ id: "selection", status: "info", detail: entries.length === 0 ? "the registry has no entries" : "no entry matches the selection" });
  selection.selected = selected.map((entry) => entry.id);

  const toolchainsById = new Map(loaded.toolchains.map((toolchain) => [toolchain.id, toolchain]));
  // An entry's toolchains are looked for from its own directories (probeDirs). Entries that
  // find a tool in the same place share one probe, so a command runs once per place.
  const probes = new Map<string, Promise<ProbeResult>>();
  const probe = (toolchain: Toolchain, dirs: ReadonlyArray<string>) => {
    const location = locateProbe(toolchain, { repo: options.repo, dirs });
    const key = [toolchain.id, location ? `${location.kind}:${location.path}` : "missing", ...(location ? [] : dirs)].join("\0");
    if (!probes.has(key)) probes.set(key, probeToolchain(toolchain, { repo: options.repo, dirs, timeoutMs: options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS }));
    return probes.get(key)!;
  };
  const reportedWarnings = new Set<string>();

  for (const entry of selected) {
    const base = { entry: entry.id, tool: entry.tool, entry_status: entry.status, gate: entryGate(entry) };
    if (entry.status === "planned" || entry.check === undefined) {
      checks.push({ id: `spec.${entry.id}`, status: "skipped", detail: "planned: no check yet", ...base });
      continue;
    }
    const unknownToolchains = (entry.requires ?? []).filter((id) => !toolchainsById.has(id));
    if (unknownToolchains.length > 0) {
      checks.push({ id: `spec.${entry.id}`, status: "error", detail: `not run: requires unknown toolchain ${unknownToolchains.join(", ")}`, ...base });
      continue;
    }
    const required = (entry.requires ?? []).map((id) => toolchainsById.get(id)!);
    const { providers, warning } = toolProviders(entry, loaded.toolchains);
    if (warning) checks.push(warning);
    const dirs = probeDirs(options.repo, entry);
    const results = await Promise.all(required.map((toolchain) => probe(toolchain, dirs)));
    for (const result of results) {
      const reported = `${result.id}\0${result.detail}`;
      if (result.usable && result.status === "warn" && !reportedWarnings.has(reported)) {
        reportedWarnings.add(reported);
        checks.push({ id: `toolchain.${result.id}`, status: "warn", detail: result.detail });
      }
    }
    const missing = results.filter((result) => !result.usable);
    if (missing.length > 0) {
      checks.push({ id: `spec.${entry.id}`, status: fails(entry), detail: `not run: missing toolchain ${missing.map((result) => `${result.id} (${result.detail})`).join("; ")}`, ...base });
      continue;
    }
    const cwd = entry.workdir === undefined ? { real: realpathSync(options.repo), exists: true } : resolveInsideRepo(options.repo, entry.workdir);
    if ("error" in cwd || !cwd.exists) {
      checks.push({ id: `spec.${entry.id}`, status: fails(entry), detail: `not run: workdir ${"error" in cwd ? cwd.error : "does not exist"}`, ...base });
      continue;
    }
    const timeoutSeconds = entry.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
    const [program, ...args] = entry.check;
    const result = await runCommandAsync(program, args, {
      cwd: cwd.real,
      timeoutMs: timeoutSeconds * 1000,
      maxBuffer: CHECK_OUTPUT_LIMIT,
      // The tool's own toolchains fix their environment (telemetry opt-outs) even when
      // `requires` leaves them out.
      env: toolchainEnvironment([...new Set([...required, ...providers])]),
    });
    const run = { ...base, command: entry.check, duration_ms: result.durationMs ?? 0, exit_code: result.exitCode };
    if (result.exitCode === 0) {
      checks.push({ id: `spec.${entry.id}`, status: "ok", detail: `passed in ${seconds(result.durationMs ?? 0)}`, ...run });
      continue;
    }
    const why = result.timedOut
      ? `timed out after ${timeoutSeconds} s`
      : result.outputTruncated
        ? `stopped: output passed ${CHECK_OUTPUT_LIMIT / (1024 * 1024)} MB`
        : result.exitCode === null
          ? `could not run ${program} (${result.errorCode ?? "no exit code"})`
          : `failed with exit ${result.exitCode}`;
    const tail = hideHome(safeDetail([result.stdout, result.stderr].filter(Boolean).join("\n"), 2_000));
    checks.push({ id: `spec.${entry.id}`, status: fails(entry), detail: tail ? `${why}\n${tail}` : why, ...run });
  }
  return { checks, selection };
}

// ── init ────────────────────────────────────────────────────────────────────────────

const REPO_NAME = /^[A-Za-z0-9._-]+$/u;

/** The registry template with `repo` set. */
export function renderTemplate(repoName: string): string {
  return readText(TEMPLATE_FILE).replace(/^repo = ".*"$/mu, `repo = "${repoName}"`);
}

export function initRegistry(repo: string, options: { apply: boolean; name?: string }): { checks: Check[]; template?: string } {
  const name = options.name ?? basename(repo);
  if (!REPO_NAME.test(name)) return { checks: [{ id: "init", status: "error", detail: `"${name}" is not a repository name; pass --name` }] };
  const template = renderTemplate(name);
  if (!options.apply) return { checks: [{ id: "init", status: "info", detail: `template for ${name}; pass --apply to write ${REGISTRY_FILE}` }], template };
  const where = resolveInsideRepo(repo, REGISTRY_FILE);
  if ("error" in where) return { checks: [{ id: "init", status: "error", detail: where.error }] };
  if (where.exists || lexists(join(repo, REGISTRY_FILE))) return { checks: [{ id: "init", status: "error", detail: `${REGISTRY_FILE} already exists; it was not changed` }] };
  try {
    mkdirSync(dirname(where.real), { recursive: true });
    // "wx" refuses an existing path, a symlink included, so a race cannot overwrite one.
    writeFileSync(where.real, template, { flag: "wx" });
  } catch (error) {
    return { checks: [{ id: "init", status: "error", detail: `could not write ${REGISTRY_FILE}: ${error instanceof Error ? error.message : String(error)}` }] };
  }
  return { checks: [{ id: "init", status: "ok", detail: `wrote ${REGISTRY_FILE} for ${name}` }] };
}

// ── block ───────────────────────────────────────────────────────────────────────────

export function loadAgentLoop(): string[] {
  const policy = readYaml<any>(POLICY_FILE);
  const steps = Array.isArray(policy.agent_loop) ? policy.agent_loop : [];
  return steps.map((step: any) => String(step.text || "")).filter(Boolean);
}

/**
 * The managed section, markers included, rendered from the registry and the agent loop.
 * `skills` adds the pointer to CI-Agent-Sync's skills; blockChecks sets it when this
 * release carries a skills/ folder, so the block never links to one that does not exist.
 */
export function renderSpecBlock(registry: SpecRegistry, loop: ReadonlyArray<string>, options: { skills?: boolean } = {}): string {
  const entries = registry.spec ?? [];
  const active = entries.filter((entry) => entry.status !== "planned");
  const planned = entries.filter((entry) => entry.status === "planned");
  const lines = [
    BLOCK_BEGIN,
    `<!-- Managed by CI Agent Sync from ${REGISTRY_FILE}. Edit the registry, then run \`agentctl spec block --apply\`. -->`,
    "## Specifications and verification",
    "",
    `This repository keeps its formal and executable specifications in \`${REGISTRY_FILE}\`. Each entry names its tool, its artefacts, the code it covers and its \`check\` command.`,
    "",
    ...loop.map((step, index) => `${index + 1}. ${step}`),
    "",
  ];
  if (active.length > 0) {
    lines.push("| Entry | Tool | Status | Gate |", "| --- | --- | --- | --- |");
    for (const entry of active) lines.push(`| \`${entry.id}\` | ${entry.tool} | ${entry.status} | ${entryGate(entry)} |`);
  } else {
    lines.push("No entry has a check yet.");
  }
  lines.push("");
  if (planned.length > 0) {
    lines.push(`Planned: ${planned.map((entry) => `\`${entry.id}\` (${[entry.tool, entry.target].filter(Boolean).join(", ")})`).join(", ")}.`, "");
  }
  const pointer = `The registry format, the verification policy and the toolchain recipes are in CI-Agent-Sync's [integrations/verification/](${REPO_URL}/tree/main/integrations/verification).`;
  const skills = ` Its skills are in [skills/](${REPO_URL}/tree/main/skills): \`npx skills add companionintelligence/CI-Agent-Sync\`.`;
  lines.push(`${pointer}${options.skills ? skills : ""}`, BLOCK_END);
  return lines.join("\n");
}

/** Put `block` into `current`: replace the marked section, or append one. Nothing else changes. */
export function applyBlock(current: string | undefined, block: string): { text: string } | { error: string } {
  if (current === undefined || current === "") return { text: `${block}\n` };
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const rendered = newline === "\n" ? block : block.replaceAll("\n", "\r\n");
  const begins = current.split(BLOCK_BEGIN).length - 1;
  const ends = current.split(BLOCK_END).length - 1;
  if (begins === 0 && ends === 0) {
    const separator = current.endsWith(newline) ? newline : `${newline}${newline}`;
    return { text: `${current}${separator}${rendered}${newline}` };
  }
  const start = current.indexOf(BLOCK_BEGIN);
  const end = current.indexOf(BLOCK_END);
  if (begins !== 1 || ends !== 1 || end < start) return { error: `found ${begins} begin and ${ends} end markers; fix them by hand` };
  return { text: `${current.slice(0, start)}${rendered}${current.slice(end + BLOCK_END.length)}` };
}

type BlockTarget = { names: string[]; real?: string; current?: string; error?: string };

function blockTargets(repo: string): BlockTarget[] {
  const present = BLOCK_FILES.filter((name) => lexists(join(repo, name)));
  const names = present.length > 0 ? present : ["AGENTS.md"];
  const targets: BlockTarget[] = [];
  for (const name of names) {
    const where = resolveInsideRepo(repo, name);
    if ("error" in where) {
      targets.push({ names: [name], error: where.error });
      continue;
    }
    // AGENTS.md and CLAUDE.md may be one file through a symlink; update it once.
    const same = targets.find((target) => target.real === where.real);
    if (same) {
      same.names.push(name);
      continue;
    }
    try {
      targets.push({ names: [name], real: where.real, ...(where.exists ? { current: readFileSync(where.real, "utf8") } : {}) });
    } catch (error) {
      targets.push({ names: [name], error: `could not read: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return targets;
}

export function blockChecks(repo: string, mode: "print" | "check" | "apply"): { checks: Check[]; block?: string } {
  const { checks, registry } = registryChecks(loadRegistry(repo));
  if (!registry) return { checks };
  const block = renderSpecBlock(registry, loadAgentLoop(), { skills: existsSync(join(ROOT, "skills")) });
  const out: Check[] = [];
  for (const target of blockTargets(repo)) {
    const id = `block.${target.names.join("+")}`;
    if (target.error || target.real === undefined) {
      out.push({ id, status: "error", detail: target.error ?? "could not resolve" });
      continue;
    }
    const next = applyBlock(target.current, block);
    if ("error" in next) {
      out.push({ id, status: "error", detail: next.error });
      continue;
    }
    const changed = next.text !== target.current;
    if (mode === "check") {
      out.push({ id, status: changed ? "error" : "ok", detail: changed ? "out of date; run agentctl spec block --apply" : "up to date" });
    } else if (mode === "apply") {
      if (!changed) {
        out.push({ id, status: "ok", detail: "already up to date" });
        continue;
      }
      try {
        writeFileSync(target.real, next.text, target.current === undefined ? { flag: "wx" } : {});
        out.push({ id, status: "ok", detail: target.current === undefined ? "created" : "updated" });
      } catch (error) {
        out.push({ id, status: "error", detail: `could not write: ${error instanceof Error ? error.message : String(error)}` });
      }
    } else {
      out.push({ id, status: "info", detail: changed ? (target.current === undefined ? "would be created" : "would change") : "up to date" });
    }
  }
  return { checks: out, block };
}

// ── schema ──────────────────────────────────────────────────────────────────────────

export function schemaChecks(mode: "print" | "check" | "write", file = join(ROOT, SCHEMA_FILE)): { checks: Check[]; schema: string } {
  const schema = renderRegistryJsonSchema();
  const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  const same = current === schema;
  if (mode === "check") {
    return { checks: [{ id: "schema", status: same ? "ok" : "error", detail: same ? `${SCHEMA_FILE} matches src/spec-registry.ts` : `${SCHEMA_FILE} differs from the schema in src/spec-registry.ts; run agentctl spec schema --write` }], schema };
  }
  if (mode === "write") {
    if (same) return { checks: [{ id: "schema", status: "ok", detail: `${SCHEMA_FILE} is up to date` }], schema };
    writeFileSync(file, schema);
    return { checks: [{ id: "schema", status: "ok", detail: `wrote ${SCHEMA_FILE}` }], schema };
  }
  return { checks: [{ id: "schema", status: same ? "ok" : "warn", detail: same ? "matches the committed file" : "differs from the committed file" }], schema };
}

// ── command ─────────────────────────────────────────────────────────────────────────

const USAGE = `Usage:
  agentctl spec toolchains [--repo DIR] [--only IDS] [--timeout SECONDS] [--json]
  agentctl spec validate [--repo DIR] [--json]
  agentctl spec list [--repo DIR] [--json]
  agentctl spec check [--repo DIR] [--only IDS] [--tool NAMES] [--changed-from REF] [--json]
  agentctl spec init [--repo DIR] [--name REPO] [--apply] [--json]
  agentctl spec block [--repo DIR] [--check | --apply] [--json]
  agentctl spec schema [--check | --write] [--json]

--repo defaults to the current directory. Lists take commas or repeated flags.
Nothing is written without --apply or --write.`;

const ALLOWED: Record<string, ReadonlyArray<string>> = {
  toolchains: ["--json", "--repo", "--only", "--timeout"],
  validate: ["--json", "--repo"],
  list: ["--json", "--repo"],
  check: ["--json", "--repo", "--only", "--tool", "--changed-from"],
  init: ["--json", "--repo", "--name", "--apply"],
  block: ["--json", "--repo", "--check", "--apply"],
  schema: ["--json", "--check", "--write"],
};

export async function specCommand(argv: ReadonlyArray<string>): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (!subcommand || subcommand === "help" || subcommand === "--help" || subcommand === "-h") {
    console.log(USAGE);
    return subcommand ? 0 : 2;
  }
  const allowed = ALLOWED[subcommand];
  if (!allowed) {
    console.error(`unknown spec command: ${subcommand}\n${USAGE}`);
    return 2;
  }
  const args = parseSpecArgs(rest);
  const used = [...args.flags, ...args.values.keys()];
  const problems = [...args.problems, ...used.filter((flag) => !allowed.includes(flag)).map((flag) => `${flag} does not apply to spec ${subcommand}`), ...args.positional.map((token) => `unexpected argument ${token}`)];
  if (args.flags.has("--check") && (args.flags.has("--apply") || args.flags.has("--write"))) problems.push("choose one of --check, --apply and --write");
  if (problems.length > 0) {
    console.error(`${problems.join("\n")}\n${USAGE}`);
    return 2;
  }
  const json = args.flags.has("--json");
  const repo = repoOption(args);
  if (allowed.includes("--repo") && !existsSync(repo)) {
    console.error(`--repo ${displayPath(repo)} does not exist`);
    return 2;
  }

  switch (subcommand) {
    case "toolchains": {
      const timeout = lastValue(args, "--timeout");
      const timeoutSeconds = timeout === undefined ? DEFAULT_PROBE_TIMEOUT_MS / 1000 : Number(timeout);
      if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0 || timeoutSeconds > 600) {
        console.error("--timeout needs a number of seconds between 0 and 600");
        return 2;
      }
      return report(await toolchainsChecks({ repo, only: listValue(args, "--only"), timeoutMs: timeoutSeconds * 1000 }), { json, title: "Toolchains" });
    }
    case "validate":
      return report(validateChecks(repo), { json, title: "Spec registry" });
    case "list":
      return report(listChecks(repo), { json, title: "Spec entries" });
    case "check": {
      const { checks, selection } = await checkEntries({ repo, only: listValue(args, "--only"), tools: listValue(args, "--tool"), changedFrom: lastValue(args, "--changed-from") });
      return report(checks, { json, title: "Spec checks", extra: { selection } });
    }
    case "init": {
      const { checks, template } = initRegistry(repo, { apply: args.flags.has("--apply"), name: lastValue(args, "--name") });
      if (!json && template !== undefined && !checks.some((check) => check.status === "error")) {
        process.stdout.write(template);
        return 0;
      }
      return report(checks, { json, title: "Spec init", extra: template === undefined ? {} : { template } });
    }
    case "block": {
      const mode = args.flags.has("--check") ? "check" : args.flags.has("--apply") ? "apply" : "print";
      const { checks, block } = blockChecks(repo, mode);
      if (!json && mode === "print" && block !== undefined && !checks.some((check) => check.status === "error")) {
        process.stdout.write(`${block}\n`);
        for (const check of checks) console.error(`${check.id}: ${check.detail}`);
        return 0;
      }
      return report(checks, { json, title: "Spec block", extra: block === undefined ? {} : { block } });
    }
    case "schema": {
      const mode = args.flags.has("--check") ? "check" : args.flags.has("--write") ? "write" : "print";
      const { checks, schema } = schemaChecks(mode);
      if (!json && mode === "print") {
        process.stdout.write(schema);
        return 0;
      }
      return report(checks, { json, title: "Spec schema" });
    }
    default:
      return 2;
  }
}
