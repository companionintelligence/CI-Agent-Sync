import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  HOME,
  ROOT,
  copyFile,
  directoryExists,
  expandPath,
  fileExists,
  isoNow,
  platformName,
  readJson,
  readText,
  readYaml,
  relPath,
  runCommand,
  sha256,
  writeJson,
  writeText,
} from "./core.ts";

type WorkspaceRepo = { name: string; path: string; exists: boolean };

function commandOutput(command: string, args: string[]): string | null {
  const result = runCommand(command, args, { timeoutMs: 5_000 });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function detectedMachine(): string {
  return platformName() === "macos" ? "macos-laptop" : platformName() === "linux" ? "linux-workstation" : "windows-workstation";
}

function extensionIds(filePath: string): string[] {
  if (!fileExists(filePath)) return [];
  return readText(filePath).split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => line.split("@", 1)[0]);
}

function machineContext(machine: string): { config: any; name: string; ciRoot: string; paths: Record<string, string> } {
  const overlay = join(ROOT, "profiles", "machines", "local.yaml");
  const example = join(ROOT, "profiles", "machines", `${machine}.yaml.example`);
  const config = fileExists(overlay) ? readYaml(overlay) : fileExists(example) ? readYaml(example) : {};
  const profileRoot = config?.paths?.ci_root ? expandPath(config.paths.ci_root, join(HOME, "devel", "ci")) : undefined;
  const ciRoot = process.env.CI_ROOT || profileRoot || join(HOME, "devel", "ci");
  const paths = Object.fromEntries(Object.entries(config?.paths || {}).map(([name, value]) => [name, expandPath(value, ciRoot)]));
  return { config, name: machine, ciRoot, paths };
}

function workspaceRepositories(context: ReturnType<typeof machineContext>): WorkspaceRepo[] {
  const repos = readYaml<any>(join(ROOT, "repos", "companionintelligence.yaml")).repositories || [];
  const workspace = readYaml<any>(join(ROOT, "repos", "workspace.yaml"));
  const names = [...new Set(Object.values(workspace.layers || {}).flatMap((value: any) => Array.isArray(value) ? value : []))];
  const repoByName = new Map<string, any>();
  for (const repo of repos) {
    repoByName.set(repo.name, repo);
    for (const alias of repo.aliases || []) repoByName.set(alias, repo);
  }
  const overrides: Record<string, string> = {
    "Companion-Hub": "companion_hub",
    "Companion-Memory": "companion_memory",
    "CI-Hub": "companion_hub",
    "CI-Server": "companion_memory",
    "CI-Engineering": "ci_engineering",
  };
  return names.map((name: string) => {
    const repo = repoByName.get(name);
    const override = overrides[name];
    const path = override && context.paths[override]
      ? context.paths[override]
      : repo?.local_path
        ? expandPath(repo.local_path, context.ciRoot)
        : join(context.ciRoot, name);
    return { name, path, exists: directoryExists(path) };
  });
}

export function renderArtifacts(options: { agent?: string; machine?: string; output?: string } = {}): { output: string; outputs: string[]; machine: string } {
  const requested = options.agent || "all";
  const allowed = ["all", "vscode", "workspace", "aider-desk"];
  if (!allowed.includes(requested)) throw new Error(`Unknown agent: ${requested}; choose ${allowed.join(", ")}`);
  const outputRoot = options.output ? expandPath(options.output) : join(ROOT, "local", "rendered");
  const context = machineContext(options.machine && options.machine !== "auto" ? options.machine : detectedMachine());
  const workspace = readYaml<any>(join(ROOT, "repos", "workspace.yaml"));
  const repos = workspaceRepositories(context);
  const bundles = readYaml<any>(join(ROOT, "integrations", "capability-bundles.yaml"));
  const outputs: string[] = [];
  const record = (path: string) => outputs.push(path.replace(`${outputRoot}/`, ""));

  if (requested === "all") rmSync(outputRoot, { recursive: true, force: true });
  else rmSync(join(outputRoot, requested), { recursive: true, force: true });
  mkdirSync(outputRoot, { recursive: true });

  if (requested === "all" || requested === "vscode") {
    const target = join(outputRoot, "vscode");
    copyFile(join(ROOT, "integrations", "vscode", "settings.json.example"), join(target, "settings.json"));
    copyFile(join(ROOT, "integrations", "vscode", "mcp.json.example"), join(target, "mcp.json"));
    writeText(join(target, "extensions.txt"), `${extensionIds(join(ROOT, "integrations", "vscode", "extensions.txt")).join("\n")}\n`);
    ["settings.json", "mcp.json", "extensions.txt"].forEach((name) => record(join(target, name)));
  }

  if (requested === "all" || requested === "workspace") {
    const target = join(outputRoot, "workspace");
    const settings = {
      "files.exclude": { "**/.env*": true, "**/node_modules": true, "**/target": true, "**/.turbo": true },
      "search.exclude": { "**/node_modules": true, "**/dist": true, "**/build": true, "**/.yarn/cache": true },
    };
    const recommendations = extensionIds(join(ROOT, "integrations", "vscode", "extensions.txt"));
    const base = { folders: repos.map((repo) => ({ name: repo.name, path: repo.path })), settings, extensions: { recommendations } };
    const local = { ...base, folders: repos.filter((repo) => repo.exists).map((repo) => ({ name: repo.name, path: repo.path })) };
    writeJson(join(target, "companion-intelligence.code-workspace"), base);
    writeJson(join(target, "companion-intelligence.local.code-workspace"), local);
    writeJson(join(target, "repository-status.json"), repos);
    writeText(join(target, "README.md"), `# Generated Companion Intelligence workspace\n\nGenerated: ${isoNow()}\n\n- The full workspace includes the declared layer map.\n- The local workspace includes only existing checkouts.\n- Repository status contains presence only; it contains no credentials.\n\nEdit the manifests under \`repos/\` instead of these files.\n`);
    ["companion-intelligence.code-workspace", "companion-intelligence.local.code-workspace", "repository-status.json", "README.md"].forEach((name) => record(join(target, name)));
  }

  if (requested === "all" || requested === "aider-desk") {
    const target = join(outputRoot, "aider-desk");
    const template = readJson<any>(join(ROOT, "integrations", "aider-desk", "mcp-servers.json.example"));
    const replace = (value: any): any => {
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
      return typeof value === "string" ? value.replaceAll("${CI_ROOT}", context.ciRoot).replaceAll("${HOME}", HOME).replace(/\$\{([A-Z0-9_]+)_ROOT\}/g, (_match, key) => context.paths[String(key).toLowerCase()] || _match) : value;
    };
    writeJson(join(target, "mcp-servers.json"), replace(template));
    writeText(join(target, "README.md"), "# Generated Aider Desk configuration\n\nReview resolved machine paths before copying this file. Credentials and OAuth sessions are not included.\n");
    record(join(target, "mcp-servers.json"));
    record(join(target, "README.md"));
  }

  if (requested === "all") {
    const target = join(outputRoot, "clients");
    const clients: Record<string, [string, string]> = {
      hermes: ["~/.hermes/config.yaml", "./bin/agent-store with <provider> -- hermes"],
      openclaw: ["~/.openclaw/openclaw.json", "./bin/agent-store with companion-hub -- openclaw"],
      claude: ["~/.claude", "./bin/agent-store with anthropic -- claude"],
      codex: ["~/.codex", "./bin/agent-store with openai -- codex"],
      opencode: ["~/.config/opencode/opencode.jsonc", "./bin/agent-store with omniroute -- opencode"],
      "aider-desk": ["~/Library/Application Support/aider-desk", "configure provider in the desktop UI"],
      antigravity: ["~/.gemini/antigravity", "configure provider in the desktop UI"],
      pi: ["~/.pi", "configure provider in the desktop UI"],
    };
    for (const [name, [configPath, launch]] of Object.entries(clients)) {
      const defaultBundles = Array(bundles?.client_defaults?.[name] || []);
      writeText(join(target, `${name}.md`), `# ${name}\n\nNative configuration: \`${configPath}\`\n\nProvider launch example: \`${launch}\`\n\nDefault reviewed MCP bundles: ${defaultBundles.length ? defaultBundles.join(", ") : "none (opt in)"}\n\nNative OAuth/session files and app databases are intentionally not generated or copied.\n`);
      record(join(target, `${name}.md`));
    }
    copyFile(join(ROOT, "integrations", "capability-bundles.yaml"), join(target, "capability-bundles.yaml"));
    copyFile(join(ROOT, "integrations", "harnesses.yaml"), join(target, "harnesses.yaml"));
    record(join(target, "capability-bundles.yaml"));
    record(join(target, "harnesses.yaml"));
  }

  writeJson(join(outputRoot, "manifest.json"), { schema_version: 1, generated_at: isoNow(), machine: context.name, agent: requested, source_commit: commandOutput("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]), outputs });
  return { output: outputRoot, outputs, machine: context.name };
}

type BackupSource = { relative: string; source: string; kind: "json" | "yaml" | "text" };

function hermesConfigPath(): string {
  const hermes = runCommand("hermes", ["config", "path"], { timeoutMs: 5_000 });
  return hermes.exitCode === 0 && hermes.stdout.trim() ? hermes.stdout.trim() : join(HOME, ".hermes", "config.yaml");
}

export function backupSources(): BackupSource[] {
  return [
    ["hermes/config.yaml", hermesConfigPath(), "yaml"],
    ["openclaw/openclaw.json", join(HOME, ".openclaw", "openclaw.json"), "json"],
    ["claude/settings.json", join(HOME, ".claude", "settings.json"), "json"],
    ["claude/claude.json", join(HOME, ".claude", ".claude.json"), "json"],
    ["codex/config.toml", join(HOME, ".codex", "config.toml"), "text"],
    ["opencode/opencode.jsonc", join(HOME, ".config", "opencode", "opencode.jsonc"), "text"],
    ["aider-desk/config.json", join(HOME, "Library", "Application Support", "aider-desk", "config.json"), "json"],
    ["aider-desk/mcp-servers.json", join(HOME, "Library", "Application Support", "aider-desk", "mcp-servers.json"), "json"],
    ["antigravity/mcp_config.jsonc", join(HOME, ".gemini", "antigravity-ide", "mcp_config.json"), "text"],
    ["pi/models.json", join(HOME, ".pi", "agent", "models.json"), "json"],
    ["pi/models-store.json", join(HOME, ".pi", "agent", "models-store.json"), "json"],
    ["vscode/settings.json", join(HOME, "Library", "Application Support", "Code", "User", "settings.json"), "json"],
    ["vscode/mcp.json", join(HOME, "Library", "Application Support", "Code", "User", "mcp.json"), "json"],
  ].map(([relative, source, kind]) => ({ relative, source, kind: kind as BackupSource["kind"] }));
}

export function backupPlan(): { output: string; sources: Array<{ path: string; status: string }> } {
  const output = join(ROOT, "local", "backups", new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14));
  return { output, sources: backupSources().map(({ relative, source }) => ({ path: relative, status: fileExists(source) ? "copy" : "skip" })) };
}

const SENSITIVE_KEY = /api[._-]?key|(?:access|refresh|auth|gateway|remote)?[._-]?token$|(?:^|[._-])token(?:$|[._-])|secret|password|credential|cookie|session[._-]?key|private[._-]?key|authorization|oauth|auth$/i;

function scrub(value: any, key?: string): any {
  if (key && SENSITIVE_KEY.test(key)) return "<redacted>";
  if (Array.isArray(value)) return value.map((child) => scrub(child, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, scrub(child, childKey)]));
  if (typeof value === "string" && value.length > 300) return `<long string ${value.length} chars>`;
  return value;
}

function redactSource(source: BackupSource, destination: string): void {
  const raw = readFileSync(source.source, "utf8");
  if (source.kind === "json") {
    writeJson(destination, scrub(JSON.parse(raw)));
    return;
  }
  if (source.kind === "yaml") {
    writeText(destination, stringifyYaml(scrub(parseYamlSafe(raw))));
    return;
  }
  const pattern = /((?:api[_-]?key|token|secret|password|credential|authorization|cookie|session[_-]?key|private[_-]?key|oauth|auth)\s*[:=]\s*)([^,;\s}]+|"[^"]*"|'[^']*')/gi;
  writeText(destination, `${raw.split(/\r?\n/).map((line) => line.replace(pattern, "$1<redacted>")).join("\n").replace(/\n*$/, "\n")}`);
}

function parseYamlSafe(raw: string): any {
  try {
    return readYamlFromString(raw);
  } catch {
    return { redaction_error: "YAML could not be parsed", content: raw.slice(0, 300) };
  }
}

function readYamlFromString(raw: string): any {
  return parseYaml(raw);
}

export function createBackup(options: { output?: string; dryRun?: boolean } = {}): { output: string; records: any[] } {
  const output = options.output ? expandPath(options.output) : backupPlan().output;
  const sources = backupSources();
  if (options.dryRun) return { output, records: sources.map(({ relative, source }) => ({ path: relative, status: fileExists(source) ? "copy" : "skip" })) };
  mkdirSync(output, { recursive: true });
  const records: any[] = [];
  for (const source of sources) {
    if (!fileExists(source.source)) {
      records.push({ path: source.relative, status: "missing" });
      continue;
    }
    const destination = join(output, source.relative);
    mkdirSync(dirname(destination), { recursive: true });
    try {
      redactSource(source, destination);
      records.push({ path: source.relative, status: "copied-redacted", sha256: createHash("sha256").update(readFileSync(destination)).digest("hex") });
    } catch (error) {
      records.push({ path: source.relative, status: "redaction-error", detail: String(error) });
    }
  }
  // Keep backups on the TypeScript control-plane path. The old Ruby doctor
  // remains available only for explicit legacy callers; backup should not
  // reintroduce it as an implicit dependency.
  const doctor = runCommand(process.execPath, ["--experimental-strip-types", "--no-warnings", join(ROOT, "src", "cli.ts"), "doctor", "--json"], { cwd: ROOT, timeoutMs: 45_000 });
  writeText(join(output, "doctor.json"), doctor.stdout || JSON.stringify({ schema_version: 1, summary: { error: 1 }, error: "doctor did not return JSON" }, null, 2));
  records.push({ path: "doctor.json", status: doctor.exitCode === 0 ? "ok" : "warnings-or-errors", stderr_present: Boolean(doctor.stderr) });
  writeJson(join(output, "manifest.json"), { schema_version: 1, created_at: isoNow(), redacted: true, native_auth_and_state_included: false, files: records });
  return { output, records };
}
