import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type JsonObject = Record<string, any>;
export type CommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
};

export type CommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  signal?: NodeJS.Signals | null;
  errorCode?: string;
  outputTruncated?: boolean;
  durationMs?: number;
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

export function commandVersion(command: string, timeoutMs = 10_000): string | null {
  const result = runCommand(command, ["--version"], { timeoutMs });
  const firstLine = result.stdout.split(/\r?\n/).find((line) => line.trim());
  return result.exitCode === 0 ? firstLine?.trim() || null : null;
}

export function runCommand(command: string, args: string[] = [], options: CommandOptions = {}): CommandResult {
  const startedAt = Date.now();
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...options.env },
      encoding: "utf8",
      timeout: options.timeoutMs || 30_000,
      maxBuffer: options.maxBuffer || 16 * 1024 * 1024,
      killSignal: "SIGTERM",
      windowsHide: true,
    });
    const error = result.error as NodeJS.ErrnoException | undefined;
    const timedOut = error?.code === "ETIMEDOUT";
    const outputTruncated = error?.code === "ENOBUFS";
    return {
      stdout: String(result.stdout || ""),
      stderr: String(result.stderr || ""),
      exitCode: timedOut || outputTruncated ? null : result.status,
      timedOut,
      signal: result.signal,
      ...(error?.code ? { errorCode: error.code } : {}),
      outputTruncated,
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    const processError = error as NodeJS.ErrnoException;
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      exitCode: null,
      timedOut: false,
      ...(processError?.code ? { errorCode: processError.code } : {}),
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Run a child without blocking the Node event loop.
 *
 * The web control plane uses this for diagnostics. The child is detached on
 * POSIX so a timed-out command and its descendants are terminated together;
 * otherwise a misbehaving MCP or desktop CLI can keep the wizard stuck even
 * after the parent process has been killed.
 */
export function runCommandAsync(command: string, args: string[] = [], options: CommandOptions = {}): Promise<CommandResult> {
  const timeoutMs = Math.max(1, options.timeoutMs || 30_000);
  const maxBuffer = Math.max(1, options.maxBuffer || 16 * 1024 * 1024);
  const startedAt = Date.now();

  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let outputTruncated = false;
    let errorCode: string | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const terminate = (signal: NodeJS.Signals): void => {
      if (child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through to the direct child handle when the process group has
          // already exited or the platform refuses group signalling.
        }
      }
      try { child.kill(signal); } catch { /* already exited */ }
    };

    const append = (target: "stdout" | "stderr", chunk: Buffer | string): void => {
      const text = String(chunk);
      const current = target === "stdout" ? stdout : stderr;
      const remaining = maxBuffer - current.length;
      if (remaining <= 0) {
        outputTruncated = true;
        errorCode ||= "MAX_BUFFER";
        terminate("SIGTERM");
        return;
      }
      const next = current + text.slice(0, remaining);
      if (target === "stdout") stdout = next;
      else stderr = next;
      if (text.length > remaining) {
        outputTruncated = true;
        errorCode ||= "MAX_BUFFER";
        terminate("SIGTERM");
      }
    };

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      resolveResult({
        stdout,
        stderr,
        exitCode: timedOut || outputTruncated ? null : exitCode,
        timedOut,
        signal,
        ...(errorCode ? { errorCode } : {}),
        outputTruncated,
        durationMs: Date.now() - startedAt,
      });
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      errorCode ||= "ETIMEDOUT";
      terminate("SIGTERM");
      forceTimer = setTimeout(() => terminate("SIGKILL"), 250);
      forceTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();

    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      errorCode ||= error.code || "SPAWN_ERROR";
      if (!stderr) stderr = error.message;
      finish(null, null);
    });
    child.once("close", (exitCode, signal) => finish(exitCode, signal));
  });
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
    .replace(/((?:api[_-]?key|token|secret|password|credential|authorization|cookie)\s*[:=]\s*)[^\s,}\"]+/gi, "$1[REDACTED]")
    .replace(/((?:["']?)(?:api[_-]?key|token|secret|password|credential|authorization|cookie)(?:["']?\s*[:=]\s*))(["'][^"']*["']|[^,}\s]+)/gi, "$1[REDACTED]");
  return cleaned.split(/\r?\n/).filter(Boolean).slice(-20).join("\n").slice(0, maxLength);
}

const SENSITIVE_KEY = /api[._-]?key|(?:access|refresh|auth|gateway|remote)?[._-]?token$|(?:^|[._-])token(?:$|[._-])|secret|password|credential|cookie|session[._-]?key|private[._-]?key|authorization|oauth|auth$/i;

/** Redact secret-bearing object fields before returning probe payloads. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((child) => redactSecrets(child));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SENSITIVE_KEY.test(key) ? "<redacted>" : redactSecrets(child)]));
  }
  if (typeof value === "string") {
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
      .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[REDACTED]");
  }
  return value;
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

export function legacyScriptAsync(script: string, args: string[] = [], timeoutMs = 60_000): Promise<CommandResult> {
  const ruby = commandPath("ruby") || "ruby";
  return runCommandAsync(ruby, [join(ROOT, "scripts", script), ...args], { timeoutMs });
}

export function legacyStore(args: string[] = [], timeoutMs = 60_000): CommandResult {
  return runCommand(join(ROOT, "bin", "agent-store-legacy"), args, { timeoutMs });
}

// Arguments for `node` that run this control plane again. A checkout and the Homebrew
// install run the TypeScript directly; an npm install has no src/ and ships the compiled
// dist/ instead, because Node will not strip types under node_modules.
export function selfInvocation(args: string[]): string[] {
  const source = join(ROOT, "src", "cli.ts");
  if (existsSync(source)) return ["--experimental-strip-types", "--no-warnings", source, ...args];
  return ["--no-warnings", join(ROOT, "dist", "cli.js"), ...args];
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
