import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HOME,
  ROOT,
  commandPath,
  isoNow,
  parseArgs,
  parsePayload,
  redactSecrets,
  runCommand,
  runCommandAsync,
  safeDetail,
} from "./core.ts";

type Surface = { id: "companion-hub" | "companion-memory"; command: string[]; cwd?: string; env?: NodeJS.ProcessEnv; executable: string; description: string };

function splitCommand(value: string): string[] {
  return value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((token) => token.replace(/^"|"$/g, "")) || [];
}

function workspaceRoots(): string[] {
  return [process.env.CI_ROOT, join(ROOT, "..", ".."), join(ROOT, "..", "..", ".."), join(HOME, "devel", "ci")].filter(Boolean).map((path) => join(String(path))).map((path) => requireResolve(path)).filter((path, index, values) => values.indexOf(path) === index);
}

function requireResolve(path: string): string {
  return path.replace(/\/+$/, "");
}

function findRepo(names: string[], required: string[]): string | undefined {
  const explicit = names[0] === "Companion-Hub" ? process.env.CI_HUB_ROOT : process.env.CI_MEMORY_ROOT;
  const candidates = [explicit, ...workspaceRoots().flatMap((root) => [...names.map((name) => join(root, name)), join(root, "0-HUB", names[0])])].filter(Boolean) as string[];
  return candidates.find((candidate) => existsSync(candidate) && required.every((file) => existsSync(join(candidate, file))));
}

function hubSurface(): Surface | undefined {
  const configured = process.env.CIHUB_BIN || process.env.COMPANION_HUB_CLI;
  if (configured) {
    const command = splitCommand(configured);
    if (command.length) return { id: "companion-hub", command, executable: command[0], description: "configured Companion Hub CLI" };
  }
  const executable = commandPath("cihub");
  if (executable) return { id: "companion-hub", command: [executable], executable, description: "cihub" };
  const repo = findRepo(["Companion-Hub", "CI-Hub"], ["bin/cihub.cjs"]);
  const node = commandPath("node");
  const entrypoint = repo && join(repo, "bin", "cihub.cjs");
  return repo && node && entrypoint && existsSync(entrypoint) ? { id: "companion-hub", command: [node, entrypoint], cwd: repo, executable: entrypoint, description: "local Companion-Hub checkout" } : undefined;
}

function memorySurface(): Surface | undefined {
  const configured = process.env.CI_MEMORY_CLI || process.env.COMPANION_MEMORY_CLI;
  if (configured) {
    const command = splitCommand(configured);
    if (command.length) return { id: "companion-memory", command, executable: command[0], description: "configured Companion Memory CLI" };
  }
  const executable = commandPath("ci");
  if (executable) return { id: "companion-memory", command: [executable], executable, description: "ci" };
  const repo = findRepo(["CI-Memory", "Companion-Memory"], ["backend/apps/cli/package.json"]);
  const node = commandPath("node");
  const built = repo && join(repo, "backend", "apps", "cli", "dist", "ci.cjs");
  if (repo && node && built && existsSync(built)) return { id: "companion-memory", command: [node, built], cwd: repo, executable: built, description: "built Companion-Memory CLI" };

  // A source checkout is a valid development surface. The previous bridge
  // only recognized a globally installed `ci` binary or a built bundle, which
  // made a healthy local Memory API look unavailable during development.
  const source = repo && join(repo, "backend", "apps", "cli", "src", "main.ts");
  const yarn = commandPath("yarn");
  if (repo && source && existsSync(source) && yarn) {
    return {
      id: "companion-memory",
      command: [yarn, "workspace", "@ci/cli", "dev"],
      cwd: repo,
      executable: source,
      description: "Companion-Memory source CLI via Yarn",
    };
  }
  const tsxCandidates = [
    repo && join(repo, "node_modules", ".bin", "tsx"),
    repo && join(repo, "backend", "apps", "cli", "node_modules", ".bin", "tsx"),
  ].filter(Boolean) as string[];
  const tsx = tsxCandidates.find((candidate) => existsSync(candidate));
  return repo && source && tsx && existsSync(source) ? {
    id: "companion-memory",
    command: [tsx, source],
    cwd: repo,
    executable: source,
    description: "Companion-Memory source CLI via tsx",
  } : undefined;
}

function missingMessage(id: Surface["id"]): string {
  return id === "companion-hub" ? "cihub is not installed; install Companion Hub or set CIHUB_BIN/COMPANION_HUB_CLI" : "ci is not installed and no Companion-Memory checkout was found; set CI_MEMORY_ROOT or CI_MEMORY_CLI";
}

function displayCommand(command: string[]): string {
  return command.map((part, index) => {
    const previous = command[index - 1] || "";
    return /^(--?(?:api-key|token|secret|password|credential)|(?:api[_-]?key|token|secret|password|credential)=)/i.test(previous) || /^(?:api[_-]?key|token|secret|password|credential)=/i.test(part)
      ? "[REDACTED]"
      : part;
  }).join(" ");
}

function commandWithCredentials(surface: Surface, args: string[], from1Password: boolean): string[] {
  if (!from1Password || surface.id !== "companion-memory") return [...surface.command, ...args];
  return [join(ROOT, "bin", "agent-store"), "with", "companion-memory-cli", "--", ...surface.command, ...args];
}

async function runSurface(surface: Surface, args: string[], timeoutMs: number, from1Password = false): Promise<any> {
  const command = commandWithCredentials(surface, args, from1Password);
  const result = await runCommandAsync(command[0], command.slice(1), { cwd: surface.cwd, env: surface.env, timeoutMs });
  const payload = parsePayload(result.stdout);
  const status = result.exitCode === 0 ? "ok" : result.timedOut ? "error" : result.exitCode === 2 ? "warn" : "error";
  return {
    id: surface.id,
    status,
    ...(result.exitCode === null ? {} : { exit_code: result.exitCode }),
    ...(result.errorCode ? { error_code: result.errorCode } : {}),
    ...(result.durationMs === undefined ? {} : { duration_ms: result.durationMs }),
    command: displayCommand(command),
    executable: surface.executable,
    description: surface.description,
    detail: safeDetail(result.stdout || result.stderr) || (result.timedOut ? `timed out after ${timeoutMs / 1000}s` : result.exitCode === 2 ? "command needs attention (authentication or user-fixable error)" : "command failed"),
    ...(payload === undefined ? {} : { payload: redactSecrets(payload) }),
  };
}

async function statusCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  const env = parsed.values.get("--env") || process.env.CI_HUB_ENV || "local";
  const timeout = Math.max(1, Math.min(Number(parsed.values.get("--timeout") || 30), 300)) * 1_000;
  const checks: Array<Promise<any> | any> = [];
  if (!parsed.flags.has("--no-hub")) {
    const surface = hubSurface();
    checks.push(surface ? runSurface(surface, ["status", env], timeout) : { id: "companion-hub", status: "warn", detail: missingMessage("companion-hub"), suggested_action: "Install cihub or set CIHUB_BIN" });
  }
  if (!parsed.flags.has("--no-memory")) {
    const surface = memorySurface();
    const server = parsed.values.get("--memory-server") || process.env.COMPANION_MEMORY_BASE_URL || process.env.CI_SERVER_URL || "";
    const memoryArgs = [...(server ? ["--server", server] : []), "doctor", "--graphql", "--json"];
    checks.push(surface ? runSurface(surface, memoryArgs, timeout, parsed.flags.has("--from-1password")) : { id: "companion-memory", status: "warn", detail: missingMessage("companion-memory"), suggested_action: "Install @ci/cli or set CI_MEMORY_ROOT" });
  }
  const services = await Promise.all(checks);
  const summary = { ok: services.filter((service) => service.status === "ok").length, warn: services.filter((service) => service.status === "warn").length, error: services.filter((service) => service.status === "error").length };
  const result = { schema_version: 1, observed_at: isoNow(), mode: "native_cli_bridge", hub_environment: env, summary, services };
  if (parsed.flags.has("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    console.log("Companion CLI status (native surfaces)");
    for (const service of services) console.log(`${service.status === "ok" ? "✓" : service.status === "error" ? "✗" : "!"} ${service.id}: ${service.detail}`);
    console.log(`Summary: ${summary.ok} ok, ${summary.warn} warnings, ${summary.error} errors`);
  }
  return summary.error > 0 ? 1 : parsed.flags.has("--strict") && summary.warn > 0 ? 2 : 0;
}

function passthrough(kind: "hub" | "memory", args: string[]): number {
  const surface = kind === "hub" ? hubSurface() : memorySurface();
  const id = kind === "hub" ? "companion-hub" : "companion-memory";
  if (!surface) { console.error(missingMessage(id)); return 127; }
  const from1Password = kind === "memory" && args.includes("--from-1password");
  const filtered = args.filter((arg) => arg !== "--from-1password");
  const normalized = filtered.length ? filtered : ["--help"];
  if (kind === "memory") {
    const server = process.env.COMPANION_MEMORY_BASE_URL || process.env.CI_SERVER_URL;
    if (normalized.length === 1 && normalized[0] === "status") normalized.splice(0, 1, ...(server ? ["--server", server] : []), "doctor", "--graphql");
    if (normalized.length === 1 && ["llm", "inference"].includes(normalized[0])) normalized.splice(0, 1, ...(server ? ["--server", server] : []), "memory", "status");
  }
  const command = commandWithCredentials(surface, normalized, from1Password);
  const result = runCommand(command[0], command.slice(1), { cwd: surface.cwd, env: surface.env, timeoutMs: 120_000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode ?? 1;
}

export async function companionCommand(args: string[]): Promise<number> {
  const target = args.shift() || "help";
  if (target === "status") return statusCommand(args);
  if (target === "hub") return passthrough("hub", args);
  if (target === "memory") return passthrough("memory", args);
  if (target === "tui") {
    const parsed = parseArgs(args);
    if (parsed.flags.has("--once")) return statusCommand(["--json", ...args.filter((arg) => arg !== "--once")]);
    console.log("CI Agent Sync companion TUI");
    console.log("Native Hub and Memory CLIs remain authoritative; this menu is a safe launcher.\n");
    console.log("[1] Combined Hub + Memory status\n[2] Companion Hub status\n[3] Companion Hub pool status\n[4] Companion Memory connection\n[5] Companion Memory inference\n[q] Quit");
    process.stdout.write("Select: ");
    const input = await new Promise<string>((resolve) => { process.stdin.once("data", (data) => resolve(String(data).trim())); });
    if (input.toLowerCase() === "q") return 0;
    const code = input === "1" ? await statusCommand(["--env", parsed.values.get("--env") || "local"]) : input === "2" ? passthrough("hub", ["status", parsed.values.get("--env") || "local"]) : input === "3" ? passthrough("hub", ["pool", "status", parsed.values.get("--env") || "local"]) : input === "4" ? passthrough("memory", ["status"]) : input === "5" ? passthrough("memory", ["llm"]) : 2;
    return code;
  }
  console.log("agentctl companion — bridge CI Agent Sync with Companion Hub and Memory");
  console.log("Usage: agentctl companion status|hub|memory|tui");
  return target === "help" ? 0 : 2;
}
