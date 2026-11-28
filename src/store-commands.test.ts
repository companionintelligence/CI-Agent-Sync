// The commands `agentctl` and `agent-store` hand to the legacy shell script, run the way a
// person runs them: typing at a prompt, from their own folder, with no locale. Stand-ins
// replace the keychain, so nothing on this machine is read or written.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { ROOT, commandPath, hermesMetadataCommand } from "./core.ts";
import { renderArtifacts } from "./operations.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function script(path: string, lines: string[]): void {
  writeFileSync(path, `${lines.join("\n")}\n`);
  chmodSync(path, 0o755);
}

function shellChecks(folder: string): void {
  const shim = join(folder, "shim");
  const log = join(folder, "calls.log");
  const project = join(folder, "project");
  mkdirSync(shim);
  mkdirSync(project);
  // macOS reads and writes the keychain with `security`, Linux with `secret-tool`.
  script(join(shim, "security"), ["#!/bin/sh", `echo "$*" >> '${log}'`, 'case "$*" in find-generic-password*-w*) echo stand-in-key;; esac']);
  script(join(shim, "secret-tool"), ["#!/bin/sh", `case "$1" in store) cat >> '${log}';; lookup) echo stand-in-key;; esac`]);
  const env = { ...process.env, HOME: folder, USER: "tester", PATH: `${shim}${delimiter}${process.env.PATH}`, AGENT_CONFIGS_SECRET_BACKEND: "native", AGENT_CONFIGS_OP_BINARY: join(folder, "no-op") };
  const run = (bin: string, args: string[], options: { cwd?: string; input?: string; env?: NodeJS.ProcessEnv } = {}) =>
    spawnSync(join(ROOT, "bin", bin), args, { cwd: options.cwd ?? project, input: options.input, env: options.env ?? env, encoding: "utf8", timeout: 60_000 });

  for (const bin of ["agent-store", "agentctl"]) {
    const typed = `typed-at-the-prompt-${bin}`;
    const saved = run(bin, ["credentials", "set-native", "openai"], { input: `${typed}\n` });
    assert(saved.status === 0 && readFileSync(log, "utf8").includes(typed), `${bin} credentials set-native did not receive what was typed: ${saved.stdout}${saved.stderr}`);
  }

  const wrapped = run("agent-store", ["with", "openai", "--", "sh", "-c", 'pwd -P; read line && echo "read $line"; echo "key $OPENAI_API_KEY"'], { input: "hello\n" });
  assert(wrapped.status === 0 && wrapped.stdout.includes(`${realpathSync(project)}\n`), `agent-store with did not run in the caller's folder: ${wrapped.stdout}${wrapped.stderr}`);
  // The program replaces the wrapper, so a service run through it gets signals and exit status itself.
  const handed = run("agent-store", ["with", "openai", "--", "sh", "-c", "echo parent $PPID; exit 7"]);
  assert(handed.status === 7 && handed.stdout.includes(`parent ${process.pid}\n`), `agent-store with did not hand the process over: ${handed.status} ${handed.stdout}`);
  assert(wrapped.stdout.includes("read hello") && wrapped.stdout.includes("key stand-in-key"), `agent-store with lost the input or the key: ${wrapped.stdout}`);

  assert(spawnSync("git", ["init", "--quiet", project]).status === 0, "could not create a target repository");
  const synced = run("agentctl", ["sync", "--target", ".", "--json"]);
  const target = JSON.parse(synced.stdout || "{}").targets?.[0]?.path;
  assert(target && realpathSync(target) === realpathSync(project), `sync --target . resolved to ${target}, not the caller's folder`);

  for (const bin of ["agent-store", "agentctl"]) {
    const fallbacks = run(bin, ["fallbacks"]);
    assert(fallbacks.status === 0 && fallbacks.stdout.includes("Fallback policy"), `${bin} fallbacks printed nothing`);
  }

  const bare = { ...env, LANG: "", LC_ALL: "", LC_CTYPE: "", CI_ROOT: join(folder, "ci") };
  const inventory = run("agent-store", ["repos", "inventory"], { env: bare });
  assert(inventory.status === 0 && inventory.stdout.includes("missing"), `repos inventory failed without a locale: ${inventory.stderr.slice(0, 300)}`);
}

function hermesChecks(folder: string): void {
  const home = join(folder, "hermes");
  mkdirSync(join(home, "venv"), { recursive: true });
  const launcher = join(home, "hermes");
  const python = join(home, "python3");
  script(python, ["#!/bin/sh", "exit 0"]);
  // Two shell hand-overs, then Python: the shape of the desktop install.
  script(join(home, "stage2"), ["#!/bin/sh", `exec ${python} -I -c 'import hermes_cli' "$@"`]);
  script(launcher, ["#!/bin/sh", `exec ${join(home, "stage2")} "$@"`]);
  assert(hermesMetadataCommand(launcher)?.[0] === python, "the Hermes probe did not find the launcher's Python");
  // A virtual environment: a console script beside its Python.
  script(join(home, "venv", "python3"), ["#!/bin/sh", "exit 0"]);
  script(join(home, "venv", "hermes"), [`#!${join(home, "venv", "python3")}`, "from hermes_cli.main import main"]);
  script(launcher, ["#!/bin/sh", `exec "${join(home, "venv", "hermes")}" "$@"`]);
  assert(hermesMetadataCommand(launcher)?.[0] === join(home, "venv", "python3"), "the Hermes probe did not find the virtual environment's Python");
  // No Python to be found: the probe must not fall back to running Hermes.
  script(join(home, "opaque"), ["#!/bin/sh", "echo started"]);
  script(launcher, ["#!/bin/sh", `exec ${join(home, "opaque")} "$@"`]);
  assert(hermesMetadataCommand(launcher) === null && hermesMetadataCommand(join(home, "absent")) === null, "the Hermes probe offered to run a launcher it cannot read");
  script(launcher, ["#!/bin/sh", `exec ${launcher} "$@"`]);
  assert(hermesMetadataCommand(launcher) === null, "the Hermes probe offered to run a launcher that only hands over to itself");
}

function renderChecks(folder: string): void {
  const output = join(folder, "rendered");
  renderArtifacts({ agent: "aider-desk", output });
  assert(!readFileSync(join(output, "aider-desk", "mcp-servers.json"), "utf8").includes("${HUB_ROOT}"), "render left ${HUB_ROOT} in the Aider Desk config");
}

// Re-running the OpenClaw installer must keep OpenClaw's own service-env launcher in front.
function openclawInstallerChecks(folder: string): void {
  const home = join(folder, "openclaw-home");
  const shim = join(folder, "openclaw-shim");
  const plist = join(home, "Library", "LaunchAgents", "ai.openclaw.gateway.plist");
  mkdirSync(join(home, "Library", "LaunchAgents"), { recursive: true });
  mkdirSync(shim);
  script(join(shim, "security"), ["#!/bin/sh", 'case "$*" in find-generic-password*-w*) echo stand-in-key;; esac']);
  script(join(shim, "launchctl"), ["#!/bin/sh", "exit 0"]);
  const wrapper = join(home, ".local", "bin", "openclaw-gateway-with-omlx");
  const launcher = ["/bin/sh", join(home, "ai.openclaw.gateway-env-wrapper.sh"), join(home, "gateway.env")];
  const env = { ...process.env, HOME: home, USER: "tester", PATH: `${shim}${delimiter}${process.env.PATH}`, AGENT_CONFIGS_SECRET_BACKEND: "native", AGENT_CONFIGS_OP_BINARY: join(folder, "no-op"), OPENCLAW_BIN: join(shim, "openclaw") };
  for (const [written, expected] of [
    [[...launcher, "/opt/node", "/opt/openclaw.mjs", "gateway", "--port", "19999"], [...launcher, wrapper, "gateway", "--port", "19999"]],
    [["/opt/openclaw", "gateway", "--port", "18789"], [wrapper, "gateway", "--port", "18789"]],
  ]) {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>ProgramArguments</key><array>${written.map((value) => `<string>${value}</string>`).join("")}</array></dict></plist>`;
    script(join(shim, "openclaw"), ["#!/bin/sh", `[ "$1 $2" = "gateway install" ] && printf '%s' '${xml}' > '${plist}'`]);
    const run = spawnSync("zsh", [join(ROOT, "scripts", "install-openclaw-local.zsh")], { env, encoding: "utf8", timeout: 60_000 });
    assert(run.status === 0, `the OpenClaw installer failed: ${run.stdout}${run.stderr}`);
    const args = JSON.parse(spawnSync("plutil", ["-extract", "ProgramArguments", "json", "-o", "-", plist], { encoding: "utf8" }).stdout);
    assert(JSON.stringify(args) === JSON.stringify(expected), `the installer wrote ${JSON.stringify(args)}, expected ${JSON.stringify(expected)}`);
  }
}

function auditCheck(): void {
  // `openclaw doctor --non-interactive` applies migrations; an audit must only look.
  const legacy = readFileSync(join(ROOT, "bin", "agent-store-legacy"), "utf8");
  const doctorLines = legacy.split("\n").filter((line) => /(openclaw-runtime|openclaw-gateway-with-omlx)"? doctor/.test(line));
  assert(doctorLines.length === 2 && doctorLines.every((line) => line.includes("doctor --lint") && !line.includes("--non-interactive")), "the OpenClaw audit must run doctor --lint only");
}

export function storeCommandChecks(): void {
  const folder = mkdtempSync(join(tmpdir(), "store-commands-"));
  try {
    if (process.platform !== "win32" && commandPath("zsh")) shellChecks(folder);
    else console.log("store command checks: skipped the shell commands, which need zsh");
    if (process.platform !== "win32") hermesChecks(folder);
    renderChecks(folder);
    auditCheck();
    if (process.platform === "darwin" && commandPath("rg")) openclawInstallerChecks(folder);
    else console.log("store command checks: skipped the OpenClaw installer, which needs macOS and ripgrep");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
