// Verification toolchains: reading integrations/verification/toolchains.yaml, checking it,
// and probing each tool for its version.
//
// This module stays free of Effect so that `agentctl validate` and the other commands can
// load it cheaply. Probes run with a short timeout, read stdout, stderr or both (`java
// -version` writes to stderr), and never go through a shell.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { commandPath, runCommandAsync } from "./core.ts";

export const TOOLCHAINS_FILE = "integrations/verification/toolchains.yaml";
export const POLICY_FILE = "integrations/verification/policy.yaml";
export const RINGS = ["adopt", "trial", "assess", "hold"] as const;
export const TOOLCHAIN_KINDS = ["runtime", "tool", "library"] as const;
export const PROBE_STREAMS = ["stdout", "stderr", "both"] as const;
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export type ProbeStream = (typeof PROBE_STREAMS)[number];
export type CommandProbe = { readonly kind: "command"; readonly commands: string[]; readonly args: string[]; readonly stream: ProbeStream; readonly pattern: string };
export type PackageProbe = { readonly kind: "package"; readonly package: string };
export type ToolchainEnvironment = { readonly name: string; readonly value?: string; readonly purpose?: string };
export type Toolchain = {
  readonly id: string;
  readonly name: string;
  readonly kind: (typeof TOOLCHAIN_KINDS)[number];
  readonly ring: (typeof RINGS)[number];
  readonly version?: string;
  readonly minimum?: string;
  readonly provides: string[];
  readonly prerequisites: string[];
  readonly environment: ToolchainEnvironment[];
  readonly probe?: CommandProbe | PackageProbe;
};
export type Problem = { readonly id: string; readonly message: string };

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;
const MINIMUM_VERSION = /^\d+(?:\.\d+)*$/u;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

type Loose = Record<string, any>;
const isLoose = (value: unknown): value is Loose => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const isStringList = (value: unknown): boolean => Array.isArray(value) && value.every((item) => typeof item === "string");

function patternProblem(pattern: unknown): string | undefined {
  if (typeof pattern !== "string" || pattern === "") return "probe.pattern must be a non-empty string";
  try {
    const compiled = new RegExp(pattern, "mu");
    // A version is the first capture group, so a pattern without one cannot report it.
    if (new RegExp(`${compiled.source}|`, "u").exec("")!.length < 2) return "probe.pattern needs a capture group for the version";
  } catch (error) {
    return `probe.pattern does not compile: ${error instanceof Error ? error.message : String(error)}`;
  }
  return undefined;
}

function checksumProblems(install: unknown): string[] {
  if (!Array.isArray(install)) return ["install must be a list (empty for a tool on hold)"];
  const problems: string[] = [];
  install.forEach((channel, index) => {
    if (!isLoose(channel) || typeof channel.channel !== "string") {
      problems.push(`install[${index}] needs a channel`);
      return;
    }
    const sha = channel.sha256;
    const shaValues = typeof sha === "string" ? [sha] : isLoose(sha) ? Object.values(sha) : sha === undefined ? [] : [null];
    for (const value of shaValues) if (typeof value !== "string" || !SHA256.test(value)) problems.push(`install[${index}].sha256 must be 64 lowercase hex digits`);
    const integrity = channel.integrity;
    const integrityValues = typeof integrity === "string" ? [integrity] : isLoose(integrity) ? Object.values(integrity) : integrity === undefined ? [] : [null];
    for (const value of integrityValues) if (typeof value !== "string" || !value.startsWith("sha512-")) problems.push(`install[${index}].integrity must be an npm sha512 integrity`);
    if (typeof channel.command === "string" && /@latest\b/u.test(channel.command)) problems.push(`install[${index}].command uses a floating @latest tag`);
  });
  return problems;
}

/**
 * Read toolchains.yaml into typed entries and list every problem with it. `knownTools` is
 * the registry's `tool` vocabulary; every value but "other" must be provided by a
 * toolchain that is not on hold.
 */
export function readToolchains(raw: unknown, knownTools: ReadonlyArray<string>): { toolchains: Toolchain[]; problems: Problem[] } {
  const problems: Problem[] = [];
  const toolchains: Toolchain[] = [];
  if (!isLoose(raw) || raw.version !== 1) problems.push({ id: "version", message: "toolchains.yaml must start with version: 1" });
  const entries = isLoose(raw) && Array.isArray(raw.toolchains) ? raw.toolchains : [];
  if (!isLoose(raw) || !Array.isArray(raw.toolchains)) problems.push({ id: "toolchains", message: "toolchains must be a list" });
  const ids = entries.map((entry: unknown) => (isLoose(entry) ? entry.id : undefined));
  entries.forEach((entry: unknown, index: number) => {
    const label = isLoose(entry) && typeof entry.id === "string" ? entry.id : `toolchains[${index}]`;
    const local: string[] = [];
    if (!isLoose(entry)) {
      problems.push({ id: label, message: "must be a mapping" });
      return;
    }
    if (typeof entry.id !== "string" || !KEBAB.test(entry.id)) local.push("id must be kebab case");
    else if (ids.indexOf(entry.id) !== index) local.push(`duplicate id: toolchains[${ids.indexOf(entry.id)}] already uses it`);
    if (typeof entry.name !== "string" || entry.name === "") local.push("name is required");
    if (!(TOOLCHAIN_KINDS as ReadonlyArray<string>).includes(entry.kind)) local.push(`kind must be one of ${TOOLCHAIN_KINDS.join(", ")}`);
    if (!(RINGS as ReadonlyArray<string>).includes(entry.ring)) local.push(`ring must be one of ${RINGS.join(", ")}`);
    if (entry.kind === "runtime") {
      if (entry.minimum !== undefined && (typeof entry.minimum !== "string" || !MINIMUM_VERSION.test(entry.minimum))) local.push("minimum must be a quoted version such as \"22.6.0\"");
      if (entry.version !== undefined) local.push("a runtime states a minimum, not a pinned version");
    } else if (typeof entry.version !== "string" || !EXACT_VERSION.test(entry.version)) {
      local.push("version must be an exact quoted version such as \"1.2.3\"");
    }
    if (!isStringList(entry.provides)) local.push("provides must be a list of registry tools");
    for (const tool of strings(entry.provides)) if (!knownTools.includes(tool) || tool === "other") local.push(`provides names unknown registry tool "${tool}"`);
    if (entry.prerequisites !== undefined && !isStringList(entry.prerequisites)) local.push("prerequisites must be a list of toolchain ids");
    for (const prerequisite of strings(entry.prerequisites)) if (!ids.includes(prerequisite)) local.push(`prerequisite "${prerequisite}" is not a toolchain id`);
    if (typeof entry.licence !== "string" || entry.licence === "") local.push("licence is required");
    local.push(...checksumProblems(entry.install));
    const environment = Array.isArray(entry.environment) ? entry.environment : entry.environment === undefined ? [] : null;
    if (environment === null) local.push("environment must be a list");
    for (const variable of environment || []) {
      if (!isLoose(variable) || typeof variable.name !== "string" || !ENV_NAME.test(variable.name)) local.push("environment names must match ^[A-Z][A-Z0-9_]*$");
      else if (variable.value !== undefined && typeof variable.value !== "string") local.push(`environment ${variable.name} value must be a quoted string`);
    }
    let probe: CommandProbe | PackageProbe | undefined;
    if (entry.ring === "hold") {
      if (entry.probe !== undefined) local.push("a tool on hold has no probe");
      if (Array.isArray(entry.install) && entry.install.length > 0) local.push("a tool on hold has no install channel");
    } else if (!isLoose(entry.probe)) {
      local.push("probe is required");
    } else if (entry.probe.package !== undefined) {
      if (typeof entry.probe.package !== "string" || !NPM_NAME.test(entry.probe.package)) local.push("probe.package must be an npm package name");
      else probe = { kind: "package", package: entry.probe.package };
    } else {
      const commands = typeof entry.probe.command === "string" ? [entry.probe.command] : strings(entry.probe.command);
      const problem = patternProblem(entry.probe.pattern);
      if (commands.length === 0 || (Array.isArray(entry.probe.command) && commands.length !== entry.probe.command.length)) local.push("probe.command must be a command or a list of candidates");
      if (!isStringList(entry.probe.args)) local.push("probe.args must be a list of strings");
      if (!(PROBE_STREAMS as ReadonlyArray<string>).includes(entry.probe.stream)) local.push(`probe.stream must be one of ${PROBE_STREAMS.join(", ")}`);
      if (problem) local.push(problem);
      if (local.length === 0) probe = { kind: "command", commands, args: strings(entry.probe.args), stream: entry.probe.stream, pattern: entry.probe.pattern };
    }
    for (const message of local) problems.push({ id: label, message });
    if (local.length === 0) {
      toolchains.push({
        id: entry.id,
        name: entry.name,
        kind: entry.kind,
        ring: entry.ring,
        ...(entry.version !== undefined ? { version: entry.version } : {}),
        ...(entry.minimum !== undefined ? { minimum: entry.minimum } : {}),
        provides: strings(entry.provides),
        prerequisites: strings(entry.prerequisites),
        environment: (environment || []).map((variable: Loose) => ({ name: variable.name, ...(variable.value !== undefined ? { value: variable.value } : {}), ...(variable.purpose !== undefined ? { purpose: String(variable.purpose) } : {}) })),
        ...(probe ? { probe } : {}),
      });
    }
  });
  for (const tool of knownTools) {
    if (tool === "other") continue;
    const providers = entries.filter((entry: unknown) => isLoose(entry) && entry.ring !== "hold" && strings(entry.provides).includes(tool));
    if (providers.length === 0) problems.push({ id: `provides.${tool}`, message: `no toolchain outside hold provides registry tool "${tool}"` });
  }
  return { toolchains, problems };
}

/**
 * Check that policy.yaml names only known tools, kinds, gates and statuses. `tools` are the
 * registry tools provided by a toolchain that is not on hold.
 */
export function policyProblems(raw: unknown, vocabulary: { tools: ReadonlyArray<string>; kinds: ReadonlyArray<string>; gates: ReadonlyArray<string>; statuses: ReadonlyArray<string> }): Problem[] {
  const problems: Problem[] = [];
  if (!isLoose(raw) || raw.version !== 1) return [{ id: "version", message: "policy.yaml must start with version: 1" }];
  const loop = Array.isArray(raw.agent_loop) ? raw.agent_loop : [];
  if (loop.length === 0 || !loop.every((step: unknown) => isLoose(step) && typeof step.id === "string" && typeof step.text === "string" && step.text !== "")) {
    problems.push({ id: "agent_loop", message: "agent_loop must be a non-empty list of steps with id and text" });
  }
  const classes = Array.isArray(raw.change_classes) ? raw.change_classes : [];
  if (classes.length === 0) problems.push({ id: "change_classes", message: "change_classes must be a non-empty list" });
  const classIds: unknown[] = [];
  classes.forEach((changeClass: unknown, index: number) => {
    const label = isLoose(changeClass) && typeof changeClass.id === "string" ? `change_class.${changeClass.id}` : `change_classes[${index}]`;
    if (!isLoose(changeClass) || typeof changeClass.id !== "string" || !KEBAB.test(changeClass.id)) {
      problems.push({ id: label, message: "needs a kebab-case id" });
      return;
    }
    if (classIds.includes(changeClass.id)) problems.push({ id: label, message: "duplicate change class id" });
    classIds.push(changeClass.id);
    if (!isStringList(changeClass.tools)) problems.push({ id: label, message: "tools must be a list" });
    for (const tool of strings(changeClass.tools)) if (!vocabulary.tools.includes(tool)) problems.push({ id: label, message: `names unknown or held tool "${tool}"` });
    if (!isStringList(changeClass.kinds)) problems.push({ id: label, message: "kinds must be a list" });
    for (const kind of strings(changeClass.kinds)) if (!vocabulary.kinds.includes(kind)) problems.push({ id: label, message: `names unknown registry kind "${kind}"` });
    if (typeof changeClass.evidence !== "string" || changeClass.evidence === "") problems.push({ id: label, message: "evidence is required" });
  });
  const byTool = isLoose(raw.escape_hatches) && Array.isArray(raw.escape_hatches.by_tool) ? raw.escape_hatches.by_tool : null;
  if (byTool === null) problems.push({ id: "escape_hatches", message: "escape_hatches.by_tool must be a list" });
  for (const item of byTool || []) {
    if (!isLoose(item) || typeof item.tool !== "string" || !vocabulary.tools.includes(item.tool)) problems.push({ id: "escape_hatches", message: `names unknown or held tool "${isLoose(item) ? item.tool : item}"` });
    else if (!isStringList(item.forbidden) || item.forbidden.length === 0) problems.push({ id: `escape_hatches.${item.tool}`, message: "forbidden must be a non-empty list" });
  }
  const sameSet = (listed: unknown, expected: ReadonlyArray<string>) => {
    const ids = Array.isArray(listed) ? listed.map((item: unknown) => (isLoose(item) ? item.id : undefined)) : [];
    return ids.length === expected.length && expected.every((value) => ids.includes(value));
  };
  if (!isLoose(raw.gates) || !sameSet(raw.gates.levels, vocabulary.gates)) problems.push({ id: "gates.levels", message: `gate levels must be exactly ${vocabulary.gates.join(", ")}` });
  if (!isLoose(raw.gates) || !sameSet(raw.gates.statuses, vocabulary.statuses)) problems.push({ id: "gates.statuses", message: `statuses must be exactly ${vocabulary.statuses.join(", ")}` });
  for (const section of ["evidence_rules", "confidentiality", "cost"]) if (raw[section] === undefined) problems.push({ id: section, message: "section is required" });
  return problems;
}

/** The registry tools a toolchain outside hold provides. */
export function activeTools(toolchains: ReadonlyArray<Toolchain>): string[] {
  return [...new Set(toolchains.filter((toolchain) => toolchain.ring !== "hold").flatMap((toolchain) => toolchain.provides))];
}

/** Compare dotted numeric versions: negative, zero or positive. Missing parts count as 0. */
export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The version a probe printed: the first capture group of `pattern` in the chosen stream. */
export function readProbeVersion(output: { stdout: string; stderr: string }, stream: ProbeStream, pattern: string): string | undefined {
  const sources = stream === "stdout" ? [output.stdout] : stream === "stderr" ? [output.stderr] : [output.stdout, output.stderr];
  const expression = new RegExp(pattern, "mu");
  for (const source of sources) {
    const match = expression.exec(source);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function expandCandidate(candidate: string, env: NodeJS.ProcessEnv): string | undefined {
  let missing = false;
  const expanded = candidate.replace(/\$\{([A-Z][A-Z0-9_]*)\}/gu, (_, name: string) => {
    const value = env[name];
    if (!value) missing = true;
    return value || "";
  });
  return missing ? undefined : expanded;
}

/**
 * Resolve the first candidate that exists: a path, or a bare name looked up in the
 * repository's node_modules/.bin and then on PATH.
 */
export function resolveProbeCommand(candidates: ReadonlyArray<string>, repo: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const candidate of candidates) {
    const expanded = expandCandidate(candidate, env);
    if (!expanded) continue;
    if (expanded.includes("/") || expanded.includes("\\")) {
      const path = isAbsolute(expanded) ? expanded : join(repo, expanded);
      if (existsSync(path)) return path;
      continue;
    }
    const local = [join(repo, "node_modules", ".bin", expanded), ...(process.platform === "win32" ? [join(repo, "node_modules", ".bin", `${expanded}.cmd`)] : [])];
    const found = local.find((path) => existsSync(path)) || commandPath(expanded);
    if (found) return found;
  }
  return undefined;
}

export type ProbeStatus = "ok" | "warn" | "not-installed" | "info";
export type ProbeResult = {
  readonly id: string;
  readonly status: ProbeStatus;
  readonly detail: string;
  /** The tool was found and printed a version, so a check that needs it can run. */
  readonly usable: boolean;
  readonly version?: string;
  readonly command?: string;
};

/** Environment values a toolchain fixes for every run, such as telemetry opt-outs. */
export function toolchainEnvironment(toolchains: ReadonlyArray<Toolchain>): Record<string, string> {
  return Object.fromEntries(toolchains.flatMap((toolchain) => toolchain.environment.filter((variable) => variable.value !== undefined).map((variable) => [variable.name, variable.value as string])));
}

function judge(toolchain: Toolchain, version: string, where: string): { status: ProbeStatus; detail: string } {
  if (toolchain.version !== undefined) {
    return version === toolchain.version
      ? { status: "ok", detail: `${version} (pinned) at ${where}` }
      : { status: "warn", detail: `found ${version} at ${where}; pinned ${toolchain.version}` };
  }
  if (toolchain.minimum !== undefined && compareVersions(version, toolchain.minimum) < 0) {
    return { status: "warn", detail: `found ${version} at ${where}; needs ${toolchain.minimum} or later` };
  }
  return { status: "ok", detail: `${version} at ${where}${toolchain.minimum !== undefined ? ` (needs ${toolchain.minimum} or later)` : ""}` };
}

/** Probe one toolchain from `repo`. It never throws; a failure is a status. */
export async function probeToolchain(toolchain: Toolchain, options: { repo: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<ProbeResult> {
  const probe = toolchain.probe;
  if (toolchain.ring === "hold" || probe === undefined) return { id: toolchain.id, status: "info", detail: `ring ${toolchain.ring}: not probed`, usable: false };
  if (probe.kind === "package") {
    const manifest = join(options.repo, "node_modules", ...probe.package.split("/"), "package.json");
    if (!existsSync(manifest)) return { id: toolchain.id, status: "not-installed", detail: `${probe.package} is not installed in ${options.repo}`, usable: false };
    try {
      const version = String(JSON.parse(readFileSync(manifest, "utf8")).version || "");
      if (!version) return { id: toolchain.id, status: "warn", detail: `${probe.package} has no version in its package.json`, usable: false };
      return { id: toolchain.id, ...judge(toolchain, version, `node_modules/${probe.package}`), usable: true, version };
    } catch (error) {
      return { id: toolchain.id, status: "warn", detail: `could not read ${probe.package}'s package.json: ${error instanceof Error ? error.message : String(error)}`, usable: false };
    }
  }
  const env = { ...process.env, ...options.env };
  const command = resolveProbeCommand(probe.commands, options.repo, env);
  if (!command) return { id: toolchain.id, status: "not-installed", detail: `none of ${probe.commands.join(", ")} was found`, usable: false };
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const result = await runCommandAsync(command, probe.args, { cwd: options.repo, timeoutMs, maxBuffer: 64 * 1024, env: { ...options.env, ...toolchainEnvironment([toolchain]) } });
  if (result.timedOut) return { id: toolchain.id, status: "warn", detail: `${command} ${probe.args.join(" ")} timed out after ${timeoutMs / 1000} s`, usable: false, command };
  const version = readProbeVersion(result, probe.stream, probe.pattern);
  if (version === undefined) {
    const code = result.exitCode === null ? (result.errorCode ?? "no exit code") : `exit ${result.exitCode}`;
    return { id: toolchain.id, status: "warn", detail: `${command} printed no version on ${probe.stream} (${code})`, usable: false, command };
  }
  return { id: toolchain.id, ...judge(toolchain, version, command), usable: true, version, command };
}
