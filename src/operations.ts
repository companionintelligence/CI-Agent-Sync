import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, type Stats } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { redactConfigText, type ConfigKind } from "./redact-config.ts";
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
  selfInvocation,
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

// Render replaces what an earlier render wrote. It marks its output folder so a
// later run can tell that folder from one the user filled. In a folder it
// recognises it replaces only the entries it writes; any other folder with files
// in it needs --force.
export const RENDER_MARKER = ".agent-sync-render.json";
const RENDER_AGENTS = ["all", "vscode", "workspace", "aider-desk"];
const RENDER_ENTRIES = new Set(["manifest.json", "vscode", "workspace", "aider-desk", "clients"]);
// Files a desktop file browser leaves in any folder it shows. They do not make a
// folder the user's, and render leaves them where they are.
const DESKTOP_FILES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

function renderedBefore(root: string, entries: string[]): boolean {
  try {
    if (entries.includes(RENDER_MARKER)) return readJson<any>(join(root, RENDER_MARKER))?.tool === "agent-sync render";
    // A folder rendered before the marker existed holds render's entries and nothing else.
    const named = entries.filter((name) => !DESKTOP_FILES.has(name));
    if (!named.includes("manifest.json") || !named.every((name) => RENDER_ENTRIES.has(name))) return false;
    const manifest = readJson<any>(join(root, "manifest.json"));
    return manifest?.schema_version === 1 && typeof manifest.generated_at === "string" && RENDER_AGENTS.includes(manifest.agent) && Array.isArray(manifest.outputs);
  } catch {
    return false;
  }
}

function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function sameFolder(a: Stats, path: string): boolean {
  try {
    const b = statSync(path);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

/**
 * Why render must not replace this existing folder even with --force, or null:
 * it is the file-system root, or it holds the home folder or this checkout.
 * Folders are compared by device and inode, not by name. One folder can have
 * several spellings (a case-insensitive volume accepts any case), and a missed
 * match here would let --force through.
 */
export function protectedOutputReason(output: string): string | null {
  if (dirname(output) === output) return "it is the file-system root";
  const target = statSync(output);
  for (const [name, path] of [["the home folder", HOME], ["this checkout", ROOT]]) {
    for (let folder = realOrResolved(path); ; folder = dirname(folder)) {
      if (sameFolder(target, folder)) return `it holds ${name}`;
      if (dirname(folder) === folder) break;
    }
  }
  return null;
}

// Returns the real path of the output folder, ready for this render's files.
function prepareOutputRoot(outputRoot: string, agent: string, force: boolean): string {
  if (!lstatSync(outputRoot, { throwIfNoEntry: false })) mkdirSync(outputRoot, { recursive: true });
  let real: string;
  try {
    real = realpathSync(outputRoot);
  } catch {
    throw new Error(`Refusing to render into ${outputRoot}: it is a symbolic link to a path that does not exist`);
  }
  if (!statSync(real).isDirectory()) throw new Error(`Refusing to render into ${outputRoot}: it is not a folder`);
  const stop = protectedOutputReason(real);
  if (stop) throw new Error(`Refusing to render into ${outputRoot}: ${stop}`);
  const entries = readdirSync(real);
  const owned = entries.every((name) => DESKTOP_FILES.has(name)) || renderedBefore(real, entries);
  if (!owned && !force) {
    throw new Error(`Refusing to render into ${outputRoot}: the folder has files that render did not create. Choose a new or empty folder, or run agentctl render with --force, which with --agent all first deletes everything in the folder.`);
  }
  // In a folder render owns, it replaces only the entries it writes, so files the user
  // added stay. --force with --agent all replaces everything in a folder it does not own.
  const replaced = agent !== "all" ? [agent, "manifest.json", RENDER_MARKER] : owned ? entries.filter((name) => RENDER_ENTRIES.has(name) || name === RENDER_MARKER) : entries;
  // rmSync removes a symbolic link itself, never what it points to.
  for (const name of replaced) rmSync(join(real, name), { recursive: true, force: true });
  // A forced render of one agent leaves the other files, so the folder does not become render's.
  if (owned || agent === "all") writeJson(join(real, RENDER_MARKER), { schema_version: 1, tool: "agent-sync render", note: "Render writes this folder. The next render replaces the files and folders it wrote here and keeps the rest." });
  return real;
}

export function renderArtifacts(options: { agent?: string; machine?: string; output?: string; force?: boolean } = {}): { output: string; outputs: string[]; machine: string } {
  const requested = options.agent || "all";
  if (!RENDER_AGENTS.includes(requested)) throw new Error(`Unknown agent: ${requested}; choose ${RENDER_AGENTS.join(", ")}`);
  const outputRoot = resolve(options.output ? expandPath(options.output) : join(ROOT, "local", "rendered"));
  const context = machineContext(options.machine && options.machine !== "auto" ? options.machine : detectedMachine());
  const workspace = readYaml<any>(join(ROOT, "repos", "workspace.yaml"));
  const repos = workspaceRepositories(context);
  const bundles = readYaml<any>(join(ROOT, "integrations", "capability-bundles.yaml"));
  const outputs: string[] = [];
  const outputDir = prepareOutputRoot(outputRoot, requested, options.force === true);
  const record = (path: string) => outputs.push(path.replace(`${outputDir}/`, ""));

  if (requested === "all" || requested === "vscode") {
    const target = join(outputDir, "vscode");
    copyFile(join(ROOT, "integrations", "vscode", "settings.json.example"), join(target, "settings.json"));
    copyFile(join(ROOT, "integrations", "vscode", "mcp.json.example"), join(target, "mcp.json"));
    writeText(join(target, "extensions.txt"), `${extensionIds(join(ROOT, "integrations", "vscode", "extensions.txt")).join("\n")}\n`);
    ["settings.json", "mcp.json", "extensions.txt"].forEach((name) => record(join(target, name)));
  }

  if (requested === "all" || requested === "workspace") {
    const target = join(outputDir, "workspace");
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
    const target = join(outputDir, "aider-desk");
    const template = readJson<any>(join(ROOT, "integrations", "aider-desk", "mcp-servers.json.example"));
    const replace = (value: any): any => {
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)]));
      return typeof value === "string" ? value.replaceAll("${CI_ROOT}", context.ciRoot).replaceAll("${HOME}", HOME).replace(/\$\{([A-Z0-9_]+)_ROOT\}/g, (_match, key) => context.paths[key === "HUB" ? "companion_hub" : String(key).toLowerCase()] || _match) : value;
    };
    writeJson(join(target, "mcp-servers.json"), replace(template));
    writeText(join(target, "README.md"), "# Generated Aider Desk configuration\n\nReview resolved machine paths before copying this file. Credentials and OAuth sessions are not included.\n");
    record(join(target, "mcp-servers.json"));
    record(join(target, "README.md"));
  }

  if (requested === "all") {
    const target = join(outputDir, "clients");
    const clients: Record<string, [string, string]> = {
      hermes: ["~/.hermes/config.yaml", "./bin/agent-store with <provider> -- hermes"],
      openclaw: ["~/.openclaw/openclaw.json", "./bin/agent-store with companion-hub -- openclaw"],
      claude: ["~/.claude", "./bin/agent-store with anthropic -- claude"],
      codex: ["~/.codex", "./bin/agent-store with openai -- codex"],
      gemini: ["~/.gemini/settings.json", "sign in with Google in the CLI"],
      copilot: ["~/.copilot", "sign in with GitHub in the CLI"],
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

  writeJson(join(outputDir, "manifest.json"), { schema_version: 1, generated_at: isoNow(), machine: context.name, agent: requested, source_commit: commandOutput("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"]), outputs });
  return { output: outputRoot, outputs, machine: context.name };
}

type BackupSource = { relative: string; source: string; kind: ConfigKind; select?: (document: any) => unknown };

function hermesConfigPath(): string {
  const hermes = runCommand("hermes", ["config", "path"], { timeoutMs: 5_000 });
  return hermes.exitCode === 0 && hermes.stdout.trim() ? hermes.stdout.trim() : join(HOME, ".hermes", "config.yaml");
}

// For files that hold app state beside the MCP servers, only the servers are copied.
const mcpServersOnly = (document: any): unknown => ({ mcpServers: document?.mcpServers ?? {} });

export function backupSources(): BackupSource[] {
  const support = join(HOME, "Library", "Application Support");
  const sources: Array<[string, string, ConfigKind, BackupSource["select"]?]> = [
    ["hermes/config.yaml", hermesConfigPath(), "yaml"],
    ["openclaw/openclaw.json", join(HOME, ".openclaw", "openclaw.json"), "json"],
    ["claude/settings.json", join(HOME, ".claude", "settings.json"), "json"],
    ["claude/claude.json", join(HOME, ".claude", ".claude.json"), "json"],
    // Claude Code keeps user-scope MCP servers in ~/.claude.json, beside per-project history.
    ["claude/mcp-servers.json", join(HOME, ".claude.json"), "json", mcpServersOnly],
    ["claude-desktop/mcp-servers.json", join(support, "Claude", "claude_desktop_config.json"), "json", mcpServersOnly],
    ["codex/config.toml", join(HOME, ".codex", "config.toml"), "toml"],
    ["gemini/settings.json", join(HOME, ".gemini", "settings.json"), "json"],
    ["copilot/mcp-config.json", join(HOME, ".copilot", "mcp-config.json"), "json"],
    ["opencode/opencode.jsonc", join(HOME, ".config", "opencode", "opencode.jsonc"), "json"],
    ["aider-desk/config.json", join(support, "aider-desk", "config.json"), "json"],
    ["aider-desk/mcp-servers.json", join(support, "aider-desk", "mcp-servers.json"), "json"],
    ["antigravity/mcp_config.jsonc", join(HOME, ".gemini", "antigravity-ide", "mcp_config.json"), "json"],
    ["pi/models.json", join(HOME, ".pi", "agent", "models.json"), "json"],
    ["pi/models-store.json", join(HOME, ".pi", "agent", "models-store.json"), "json"],
    ["vscode/settings.json", join(support, "Code", "User", "settings.json"), "json"],
    ["vscode/mcp.json", join(support, "Code", "User", "mcp.json"), "json"],
  ];
  return sources.map(([relative, source, kind, select]) => ({ relative, source, kind, ...(select ? { select } : {}) }));
}

export function backupPlan(): { output: string; sources: Array<{ path: string; status: string }> } {
  const output = join(ROOT, "local", "backups", new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14));
  return { output, sources: backupSources().map(({ relative, source }) => ({ path: relative, status: fileExists(source) ? "copy" : "skip" })) };
}

// Nothing is written unless the whole file parsed and was redacted.
export function redactSource(source: BackupSource, destination: string): void {
  writeText(destination, redactConfigText(readFileSync(source.source, "utf8"), source.kind, { select: source.select }));
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
      records.push({ path: source.relative, status: "redaction-error", detail: error instanceof Error ? error.message : "could not be redacted" });
    }
  }
  // Keep backups on the TypeScript control-plane path. The old Ruby doctor
  // remains available only for explicit legacy callers; backup should not
  // reintroduce it as an implicit dependency.
  const doctor = runCommand(process.execPath, selfInvocation(["doctor", "--json"]), { cwd: ROOT, timeoutMs: 45_000 });
  writeText(join(output, "doctor.json"), doctor.stdout || JSON.stringify({ schema_version: 1, summary: { error: 1 }, error: "doctor did not return JSON" }, null, 2));
  records.push({ path: "doctor.json", status: doctor.exitCode === 0 ? "ok" : "warnings-or-errors", stderr_present: Boolean(doctor.stderr) });
  writeJson(join(output, "manifest.json"), { schema_version: 1, created_at: isoNow(), redacted: true, native_auth_and_state_included: false, files: records });
  return { output, records };
}
