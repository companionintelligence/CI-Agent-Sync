import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  HOME,
  ROOT,
  commandPath,
  commandVersion,
  directoryExists,
  expandPath,
  fileExists,
  isoNow,
  platformName,
  readJson,
  readYaml,
  runCommand,
} from "./core.ts";

type Check = { id: string; status: "ok" | "warn" | "error" | "info"; detail: string; [key: string]: unknown };

function add(checks: Check[], id: string, status: Check["status"], detail: string, extra: Record<string, unknown> = {}): void {
  checks.push({ id, status, detail, ...extra });
}

function localProfileEndpoint(name: string): string {
  const profile = join(ROOT, "profiles", "machines", "local.yaml");
  if (!fileExists(profile)) return "";
  try {
    return String(readYaml<any>(profile)?.endpoints?.[name] || "");
  } catch {
    return "";
  }
}

async function httpStatus(base: string, path: string, headers: Record<string, string> = {}): Promise<number | string> {
  try {
    const url = new URL(path.replace(/^\//, ""), `${base.replace(/\/$/, "")}/`);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_500);
    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      return response.status;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    return error instanceof Error ? `unreachable: ${error.name}` : "unreachable";
  }
}

function secretPresence(provider: string): "1Password" | "native migration store" | "not set" {
  if (process.env.AGENT_CONFIGS_SECRET_BACKEND !== "native" && commandPath(process.env.AGENT_CONFIGS_OP_BINARY || "op")) {
    const binary = process.env.AGENT_CONFIGS_OP_BINARY || "op";
    const vault = process.env.AGENT_CONFIGS_OP_VAULT || "Agent Configs";
    const items = runCommand(binary, ["item", "list", "--vault", vault, "--format=json"], { timeoutMs: 8_000 });
    if (items.exitCode === 0) {
      try {
        const parsed = JSON.parse(items.stdout);
        if (Array.isArray(parsed) && parsed.some((item) => [item.title, item.id].includes(`agent-configs-${provider}`))) return "1Password";
      } catch {
        // A malformed or unavailable item list is treated as absent.
      }
    }
  }
  if (platformName() === "macos" && commandPath("security")) {
    const result = runCommand("security", ["find-generic-password", "-a", process.env.USER || "", "-s", `agent-configs/${provider}`], { timeoutMs: 4_000 });
    if (result.exitCode === 0) return "native migration store";
  }
  if (platformName() === "linux" && commandPath("secret-tool")) {
    const result = runCommand("secret-tool", ["lookup", "service", `agent-configs/${provider}`, "account", process.env.USER || ""], { timeoutMs: 4_000 });
    if (result.exitCode === 0) return "native migration store";
  }
  return "not set";
}

function configPaths(): Record<string, string> {
  return {
    hermes: join(HOME, ".hermes", "config.yaml"),
    openclaw: join(HOME, ".openclaw", "openclaw.json"),
    claude: join(HOME, ".claude"),
    chatgpt: join(HOME, "Library", "Application Support", "com.openai.chat"),
    codex: join(HOME, ".codex"),
    opencode: join(HOME, ".config", "opencode"),
    ollama: join(HOME, ".ollama"),
    "aider-desk": join(HOME, "Library", "Application Support", "aider-desk"),
    antigravity: join(HOME, ".gemini", "antigravity"),
    pi: join(HOME, ".pi"),
  };
}

function workspaceCheck(checks: Check[]): void {
  const manifestPath = join(ROOT, "repos", "companionintelligence.yaml");
  try {
    const manifest = readYaml<any>(manifestPath);
    const profilePath = join(ROOT, "profiles", "machines", "local.yaml");
    const profile = fileExists(profilePath) ? readYaml<any>(profilePath) : {};
    const ciRoot = process.env.CI_ROOT || expandPath(profile?.paths?.ci_root || join(HOME, "devel", "ci"));
    const overrides: Record<string, string> = { "Companion-Hub": "companion_hub", "Companion-Memory": "companion_memory", "CI-Engineering": "ci_engineering" };
    let present = 0;
    let dirty = 0;
    let missing = 0;
    for (const repo of manifest.repositories || []) {
      const path = overrides[repo.name] && profile?.paths?.[overrides[repo.name]]
        ? expandPath(profile.paths[overrides[repo.name]], ciRoot)
        : expandPath(repo.local_path, ciRoot);
      if (!directoryExists(join(path, ".git"))) {
        missing += 1;
        continue;
      }
      present += 1;
      const status = runCommand("git", ["-C", path, "status", "--porcelain"], { timeoutMs: 5_000 });
      if (status.exitCode === 0 && status.stdout.trim()) dirty += 1;
    }
    add(checks, "workspace.repositories", dirty === 0 ? "ok" : "warn", `${present} present, ${dirty} dirty, ${missing} missing`);
  } catch (error) {
    add(checks, "workspace.repositories", "error", `manifest could not be read: ${String(error)}`);
  }
}

export async function doctor(options: { json?: boolean; strict?: boolean } = {}): Promise<{ exitCode: number; result: any }> {
  const checks: Check[] = [];
  const required = ["node", "npm", "git", "rg"];
  for (const command of required) {
    const path = commandPath(command);
    add(checks, `command.${command}`, path ? "ok" : "error", path ? `${commandVersion(command) || "installed"} — ${path}` : "not installed");
  }
  const compatibility = commandPath("ruby");
  add(checks, "command.ruby-legacy", compatibility ? "info" : "warn", compatibility ? "available for legacy compatibility scripts" : "not installed; specialized legacy commands unavailable");

  const optional = ["code", "hermes", "openclaw", "claude", "codex", "opencode", "ollama", "wrangler", "cihub", "tailscale", "npx", "pnpm", "yarn", "docker"];
  for (const command of optional) {
    const path = commandPath(command);
    add(checks, `command.${command}`, path ? "ok" : "warn", path ? `${commandVersion(command) || "installed"} — ${path}` : "not installed on this machine");
  }

  for (const [name, path] of Object.entries(configPaths())) add(checks, `config.${name}`, existsSync(path) ? "ok" : "warn", existsSync(path) ? "present" : "missing");

  const op = commandPath(process.env.AGENT_CONFIGS_OP_BINARY || "op");
  if (op) {
    const vault = runCommand(op, ["vault", "list", "--format=json"], { timeoutMs: 8_000 });
    add(checks, "credential-backend.onepassword", vault.exitCode === 0 ? "ok" : "warn", vault.exitCode === 0 ? "1Password CLI authenticated; values are never printed" : "1Password CLI installed but not authenticated");
  } else add(checks, "credential-backend.onepassword", "warn", "1Password CLI is not installed");

  for (const provider of ["anthropic", "openai", "openrouter", "ollama", "omlx", "companion-hub", "companion-memory", "cloudflare"]) {
    const source = secretPresence(provider);
    add(checks, `credential.${provider}`, source === "1Password" ? "ok" : "warn", source === "not set" ? "not set; values are never printed" : `present in ${source}`);
  }

  try {
    for (const relative of ["providers/providers.yaml", "providers/onepassword.yaml", "integrations/mcp/registry.yaml", "integrations/capability-bundles.yaml", "integrations/harnesses.yaml", "integrations/providers/routing.yaml", "integrations/providers/fallbacks.yaml", "integrations/deployment-targets.yaml", "integrations/fleet/targets.yaml", "repos/companionintelligence.yaml", "repos/workspace.yaml"]) readYaml(join(ROOT, relative));
    for (const relative of ["integrations/vscode/settings.json.example", "integrations/vscode/mcp.json.example"]) readJson(join(ROOT, relative));
    add(checks, "store.manifests", "ok", "YAML and JSON templates parse");
  } catch (error) {
    add(checks, "store.manifests", "error", `parse failure: ${String(error)}`);
  }

  const ollama = (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/v1$/, "");
  const omlx = (process.env.OMLX_BASE_URL || "http://127.0.0.1:8000").replace(/\/v1$/, "");
  const omniroute = process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128";
  const ollamaCode = await httpStatus(ollama, "/api/tags");
  add(checks, "runtime.ollama", ollamaCode === 200 ? "ok" : "warn", `HTTP ${ollamaCode}`);
  const omlxCode = await httpStatus(omlx, "/v1/models");
  add(checks, "runtime.omlx", omlxCode === 200 || omlxCode === 401 ? "ok" : "warn", omlxCode === 401 ? "HTTP 401; local oMLX endpoint is up and needs its access key" : `HTTP ${omlxCode}`);
  let gatewayHost = "";
  try { gatewayHost = new URL(omniroute).hostname; } catch { /* handled below */ }
  add(checks, "runtime.omniroute.binding", ["127.0.0.1", "localhost"].includes(gatewayHost) ? "ok" : "error", gatewayHost ? `bound to ${gatewayHost}` : "invalid endpoint");
  const gatewayCode = await httpStatus(omniroute, "/v1/models");
  add(checks, "runtime.omniroute.models", gatewayCode === 200 ? "ok" : "warn", gatewayCode === 401 ? "HTTP 401; gateway is protected and needs its access key" : `HTTP ${gatewayCode}`);

  const hub = process.env.COMPANION_HUB_BASE_URL || process.env.CI_SERVER_URL || localProfileEndpoint("companion_hub");
  const hubCode = hub ? await httpStatus(hub, "/api/health") : null;
  add(checks, "runtime.companion-hub", hub ? hubCode === 200 ? "ok" : "warn" : "warn", hub ? `HTTP ${hubCode}` : "COMPANION_HUB_BASE_URL/CI_SERVER_URL is not configured");
  const memory = process.env.COMPANION_MEMORY_BASE_URL || localProfileEndpoint("companion_memory");
  const memoryCode = memory ? await httpStatus(memory, "/api/health") : null;
  add(checks, "runtime.companion-memory", memory ? memoryCode === 200 ? "ok" : "warn" : "warn", memory ? `HTTP ${memoryCode}` : "COMPANION_MEMORY_BASE_URL is not configured");
  workspaceCheck(checks);

  const summary = Object.fromEntries(["ok", "warn", "error", "info"].map((status) => [status, checks.filter((check) => check.status === status).length]));
  const result = { schema_version: 1, generated_at: isoNow(), summary, checks };
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    console.log("CI Agent Sync doctor");
    for (const check of checks) console.log(`${check.status === "ok" ? "✓" : check.status === "error" ? "✗" : check.status === "info" ? "·" : "!"} ${check.id}: ${check.detail}`);
    console.log(`Summary: ${summary.ok} ok, ${summary.warn} warnings, ${summary.error} errors`);
  }
  const exitCode = summary.error > 0 || (options.strict && summary.warn > 0) ? 1 : 0;
  return { exitCode, result };
}
