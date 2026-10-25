import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HOME,
  ROOT,
  commandPath,
  expandPath,
  parseArgs,
  parsePayload,
  platformName,
  readYaml,
  runCommand,
  safeDetail,
} from "./core.ts";

type Status = "ok" | "warn" | "not-installed" | "error";
type Check = { id: string; status: Status; detail: string; [key: string]: unknown };
type HarnessMetadata = {
  command?: string;
  app_paths?: string[];
  config_paths?: Record<string, string>;
  version_probe?: string;
};

function add(checks: Check[], id: string, status: Status, detail: string, extra: Record<string, unknown> = {}): void {
  checks.push({ id, status, detail, ...extra });
}

function withId(id: string, check: Check): Check {
  const { id: _ignored, ...rest } = check;
  return { id, ...rest };
}

function timeoutSeconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value || fallback);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 300)) : fallback;
}

function metadataVersionCommand(command: string): [string, string[]] {
  const fallback: [string, string[]] = [command, ["--version"]];
  const executable = commandPath(command);
  if (!executable) return fallback;
  try {
    const launcher = readFileSync(executable, "utf8").slice(0, 16_384);
    const match = launcher.match(/exec\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s+"\$@"/);
    const delegated = match?.[1] || match?.[2] || match?.[3];
    if (!delegated || !existsSync(delegated) || !readFileSync(delegated, "utf8").slice(0, 16_384).includes("hermes_cli")) return fallback;
    const sibling = join(delegated, "..", "python3");
    const python = existsSync(sibling) ? sibling : delegated;
    return [python, ["-c", "import importlib.metadata as m; print(m.version('hermes-agent'))"]];
  } catch {
    return fallback;
  }
}

function harnessCommand(name: string, metadata: HarnessMetadata): [string, string[]] {
  if (name === "openclaw") return [join(ROOT, "bin", "openclaw-runtime"), ["--version"]];
  if (name === "hermes" && metadata.version_probe === "metadata") return metadataVersionCommand(metadata.command || "hermes");
  return [metadata.command || "", ["--version"]];
}

function commandProbe(command: string, args: string[], timeoutMs: number): Check {
  if (!command) return { id: "command", status: "not-installed", detail: "command not found" };
  const result = runCommand(command, args, { timeoutMs });
  if (result.timedOut || result.exitCode === null) return { id: "command", status: "warn", detail: `timed out after ${timeoutMs / 1000}s` };
  const payload = parsePayload(result.stdout) as any;
  const output = safeDetail([result.stdout, result.stderr].filter(Boolean).join("\n"), 500);
  const detail = payload?.ok === true
    ? "healthy"
    : output.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.includes("ExperimentalWarning") && !line.startsWith("(Use `node --trace-warnings"))
      .find(Boolean) || (result.exitCode === 0 ? "completed" : "command failed");
  return { id: "command", status: result.exitCode === 0 ? "ok" : "warn", detail };
}

async function httpProbe(base: string, path: string, timeoutMs: number): Promise<{ code: number | null; status: Status; detail: string }> {
  try {
    const url = new URL(path.replace(/^\//, ""), `${base.replace(/\/$/, "")}/`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      const detail = response.status === 401 ? "reachable but authentication is required" : `HTTP ${response.status}`;
      return { code: response.status, status: response.status === 200 ? "ok" : "warn", detail };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { code: null, status: "warn", detail: `unreachable: ${error instanceof Error ? error.name : "error"}` };
  }
}

function configPath(metadata: HarnessMetadata): string {
  return expandPath(metadata.config_paths?.[platformName()] || "");
}

async function harnessChecks(agent: string | undefined, timeoutMs: number): Promise<{ checks: Check[]; harnesses: Record<string, any> }> {
  const declared = (readYaml<any>(join(ROOT, "integrations", "harnesses.yaml")).harnesses || {}) as Record<string, HarnessMetadata>;
  const selectedNames = agent ? [agent] : Object.keys(declared);
  if (agent && !declared[agent]) throw new Error(`unknown harness ${JSON.stringify(agent)}`);
  const checks: Check[] = [];
  const harnesses: Record<string, any> = {};

  for (const name of selectedNames) {
    const metadata = declared[name];
    const result = { installed: false, configured: false, checks: [] as Check[] };
    if (metadata.command) {
      const [command, args] = harnessCommand(name, metadata);
      const probe = commandProbe(command, args, timeoutMs);
      probe.id = "version";
      result.checks.push(withId("version", probe));
      result.installed = probe.status === "ok" || Boolean(commandPath(metadata.command));
    } else {
      const present = (metadata.app_paths || []).map((path) => expandPath(path)).some((path) => existsSync(path));
      result.installed = present;
      result.checks.push({ id: "app", status: present ? "ok" : "not-installed", detail: present ? "desktop app present" : "desktop app missing" });
    }
    const path = configPath(metadata);
    result.configured = Boolean(path && existsSync(path));
    result.checks.push({ id: "config", status: result.configured ? "ok" : "warn", detail: result.configured ? path : "config root missing" });

    if (name === "openclaw") {
      result.checks.push(withId("gateway", commandProbe(join(ROOT, "bin", "openclaw-runtime"), ["gateway", "health", "--json"], timeoutMs)));
    } else if (name === "claude" && existsSync(join(HOME, ".claude", "skills"))) {
      result.checks.push(withId("skills", commandProbe("claude", ["plugin", "validate", join(HOME, ".claude", "skills")], timeoutMs)));
    } else if (name === "opencode") {
      result.checks.push(withId("mcp", commandProbe("opencode", ["mcp", "list"], timeoutMs)));
    } else if (name === "vscode") {
      const root = platformName() === "macos" ? join(HOME, "Library", "Application Support", "Code", "User") : join(HOME, ".config", "Code", "User");
      const mcp = join(root, "mcp.json");
      result.checks.push({ id: "mcp", status: existsSync(mcp) ? "ok" : "warn", detail: existsSync(mcp) ? "MCP file present" : "MCP file missing" });
    }
    harnesses[name] = result;
    for (const check of result.checks) checks.push(withId(`harness.${name}.${check.id}`, check));
  }
  return { checks, harnesses };
}

async function providerChecks(timeoutMs: number): Promise<Record<string, Check>> {
  const endpoints: Record<string, [string, string]> = {
    ollama: [process.env.OLLAMA_HOST || "http://127.0.0.1:11434", "/api/tags"],
    omlx: [(process.env.OMLX_BASE_URL || "http://127.0.0.1:8000/v1").replace(/\/v1$/, ""), "/v1/models"],
    omniroute: [process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128", "/v1/models"],
  };
  const result: Record<string, Check> = {};
  for (const [name, [base, path]] of Object.entries(endpoints)) {
    const probe = await httpProbe(base, path, timeoutMs * 1000);
    result[name] = { id: name, status: probe.status, detail: `${probe.detail}; credential values were not read` };
  }
  return result;
}

function printResult(title: string, result: any, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(title);
  for (const check of result.checks as Check[]) console.log(`${check.status === "ok" ? "✓" : check.status === "error" ? "✗" : "!"} ${check.id}: ${check.detail}`);
  const summary = result.summary;
  console.log(`Summary: ${summary.ok || 0} ok, ${summary.warn || 0} warnings, ${summary.error || 0} errors`);
}

export async function conformanceCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.flags.has("--help")) {
    console.log("Usage: agentctl conformance [--json] [--timeout SECONDS]");
    return 0;
  }
  const seconds = timeoutSeconds(parsed.values.get("--timeout"), 15);
  try {
    const { checks, harnesses } = await harnessChecks(undefined, seconds * 1000);
    const providers = await providerChecks(seconds);
    const allChecks = [...checks, ...Object.values(providers).map((check) => withId(`provider.${check.id}`, check))];
    const summary = Object.fromEntries(["ok", "warn", "error", "not-installed"].map((status) => [status, allChecks.filter((check) => check.status === status).length]));
    const result = { schema_version: 1, summary, harnesses, providers, checks: allChecks };
    printResult("CI Agent Sync conformance", result, parsed.flags.has("--json"));
    return Number(summary.error || 0) > 0 ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

export async function harnessSmokeCommand(args: string[]): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed.flags.has("--help")) {
    console.log("Usage: agentctl harness-smoke [--json] [--live-local] [--agent NAME] [--timeout SECONDS]");
    return 0;
  }
  const seconds = timeoutSeconds(parsed.values.get("--timeout"), 12);
  try {
    const { checks, harnesses } = await harnessChecks(parsed.values.get("--agent"), seconds * 1000);
    const providers = await providerChecks(seconds);
    for (const check of Object.values(providers)) checks.push(withId(`provider.${check.id}`, check));
    if (parsed.flags.has("--live-local")) {
      const gateway = await httpProbe(process.env.OMLX_BASE_URL || "http://127.0.0.1:8000", "/v1/models", seconds * 1000);
      checks.push({ id: "live.local.omlx", status: gateway.status, detail: gateway.detail });
    }
    const summary = Object.fromEntries(["ok", "warn", "error", "not-installed"].map((status) => [status, checks.filter((check) => check.status === status).length]));
    const result = { schema_version: 1, summary, harnesses, providers, checks, live_local: parsed.flags.has("--live-local") };
    printResult("CI Agent Sync harness smoke", result, parsed.flags.has("--json"));
    return Number(summary.error || 0) > 0 ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}
