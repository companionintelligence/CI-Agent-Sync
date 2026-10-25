import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type JsonObject = Record<string, any>;
export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const HOME = homedir();

export function absolutePath(value: string): string {
  return isAbsolute(value) ? value : resolve(ROOT, value);
}

export function readText(filePath: string): string {
  return readFileSync(absolutePath(filePath), "utf8");
}

export function readJson<T = JsonObject>(filePath: string): T {
  return JSON.parse(readText(filePath)) as T;
}

export function readYaml<T = JsonObject>(filePath: string): T {
  return (parseYaml(readText(filePath)) || {}) as T;
}

export function writeText(filePath: string, value: string): void {
  const target = absolutePath(filePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

export function writeJson(filePath: string, value: unknown): void {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeYaml(filePath: string, value: unknown): void {
  writeText(filePath, stringifyYaml(value));
}

export function copyFile(source: string, destination: string): void {
  const target = absolutePath(destination);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(absolutePath(source), target);
}

export function fileExists(filePath: string): boolean {
  return existsSync(absolutePath(filePath));
}

export function directoryExists(filePath: string): boolean {
  try {
    return statSync(absolutePath(filePath)).isDirectory();
  } catch {
    return false;
  }
}

export function labelFor(identifier: string): string {
  return identifier.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

export function expandPath(value: unknown, ciRoot = process.env.CI_ROOT || join(HOME, "devel", "ci")): string {
  return String(value ?? "")
    .replaceAll("${CI_ROOT}", ciRoot)
    .replaceAll("${HOME}", HOME)
    .replaceAll("${USERPROFILE}", process.env.USERPROFILE || HOME)
    .replaceAll("${APPDATA}", process.env.APPDATA || join(HOME, "Library", "Application Support"));
}

export function platformName(): "macos" | "linux" | "windows" {
  if (platform() === "darwin") return "macos";
  if (platform() === "linux") return "linux";
  return "windows";
}

export function commandPath(command: string): string | null {
  if (command.includes("/")) return existsSync(command) ? command : null;
  const pathValue = process.env.PATH || "";
  for (const directory of pathValue.split(delimiter)) {
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export function commandVersion(command: string): string | null {
  const result = runCommand(command, ["--version"], { timeoutMs: 10_000 });
  const firstLine = result.stdout.split(/\r?\n/).find((line) => line.trim());
  return result.exitCode === 0 ? firstLine?.trim() || null : null;
}

export function runCommand(command: string, args: string[] = [], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): CommandResult {
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...options.env },
      encoding: "utf8",
      timeout: options.timeoutMs || 30_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const timedOut = (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    return {
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
      exitCode: timedOut ? null : result.status,
      timedOut,
    };
  } catch (error) {
    return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: null, timedOut: false };
  }
}

export function runInteractive(command: string, args: string[] = [], cwd = ROOT): number {
  const result = spawnSync(command, args, { cwd, env: process.env, stdio: "inherit" });
  return result.status ?? 1;
}

export function safeDetail(value: unknown, maxLength = 5_000): string {
  let cleaned = String(value ?? "").replace(/\u001b\[[0-?]*[ -\/]*[@-~]/g, "");
  cleaned = cleaned
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|credential|authorization|cookie)\s*[:=]\s*)[^\s,}\"]+/gi, "$1[REDACTED]");
  return cleaned.split(/\r?\n/).filter(Boolean).slice(-20).join("\n").slice(0, maxLength);
}

export function parsePayload(output: string): unknown {
  try {
    const parsed = JSON.parse(output);
    return parsed && (typeof parsed === "object" || Array.isArray(parsed)) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function sha256(filePath: string): string {
  return createHash("sha256").update(readFileSync(absolutePath(filePath))).digest("hex");
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function relPath(filePath: string): string {
  return relative(ROOT, absolutePath(filePath));
}

export function contentType(filePath: string): string {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".ts": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".md": "text/markdown; charset=utf-8",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
  }[extname(filePath).toLowerCase()] || "application/octet-stream";
}

export function safeChildPath(root: string, requestPath: string): string | null {
  const base = resolve(root);
  const candidate = resolve(base, requestPath.replace(/^\/+/, ""));
  return candidate === base || candidate.startsWith(`${base}${sep}`) ? candidate : null;
}

export function legacyScript(script: string, args: string[] = [], timeoutMs = 60_000): CommandResult {
  const ruby = commandPath("ruby") || "ruby";
  return runCommand(ruby, [join(ROOT, "scripts", script), ...args], { timeoutMs });
}

export function legacyStore(args: string[] = [], timeoutMs = 60_000): CommandResult {
  return runCommand(join(ROOT, "bin", "agent-store-legacy"), args, { timeoutMs });
}

export function outputResult(result: CommandResult): number {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.exitCode ?? 1;
}

export function parseArgs(args: string[]): { positional: string[]; flags: Set<string>; values: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const [key, inline] = value.split("=", 2);
    if (inline !== undefined) {
      values.set(key, inline);
      continue;
    }
    const next = args[index + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, next);
      index += 1;
    } else {
      flags.add(key);
    }
  }
  return { positional, flags, values };
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
