import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import {
  ROOT,
  contentType,
  labelFor,
  legacyScriptAsync,
  readYaml,
  redactSecrets,
  safeChildPath,
  safeDetail,
} from "./core.ts";
import { backupPlan, createBackup, renderArtifacts } from "./operations.ts";
import { doctor } from "./doctor.ts";

export const APP_NAME = "CI Agent Sync";
export const APP_VERSION = "0.2.0";
const WEB_ROOT = join(ROOT, "web");

function json(value: unknown): string {
  return JSON.stringify(value);
}

function overviewPayload(): any {
  const providers = readYaml<any>(join(ROOT, "providers", "providers.yaml")).providers || {};
  const harnesses = readYaml<any>(join(ROOT, "integrations", "harnesses.yaml")).harnesses || {};
  const bundles = readYaml<any>(join(ROOT, "integrations", "capability-bundles.yaml")).bundles || {};
  const servers = readYaml<any>(join(ROOT, "integrations", "mcp", "registry.yaml")).servers || {};
  const marketplace = readYaml<any>(join(ROOT, "integrations", "marketplace-harnesses.yaml")).harnesses || {};
  const profiles = readYaml<any>(join(ROOT, "integrations", "operator-contract.yaml")).profiles || {};
  return {
    app: { name: APP_NAME, version: APP_VERSION, tagline: "Portable policy for every agent, model, and mission.", safety: "Loopback-only · explicit local actions · no secrets in the browser" },
    generated_at: new Date().toISOString(),
    counts: { harnesses: Object.keys(harnesses).length, providers: Object.keys(providers).length, mcp_servers: Object.keys(servers).length, bundles: Object.keys(bundles).length, marketplace_harnesses: Object.keys(marketplace).length },
    providers: Object.entries(providers).map(([id, provider]: [string, any]) => ({ id, name: labelFor(id), env: provider.env, endpoint_env: provider.endpoint_env, clients: provider.primary_clients || [], class: provider.class || (id.startsWith("companion-") ? "companion" : "model") })),
    harnesses: Object.entries(harnesses).map(([id, harness]: [string, any]) => ({ id, name: labelFor(id), command: harness.command, capabilities: harness.capabilities || [], smoke: harness.smoke })),
    bundles: Object.entries(bundles).map(([id, bundle]: [string, any]) => ({ id, name: labelFor(id), description: bundle.description, servers: bundle.servers || [], high_risk: bundle.high_risk === true })),
    marketplace: Object.entries(marketplace).map(([id, contract]: [string, any]) => ({ id, name: labelFor(id), slug: contract.marketplace_slug, repository: contract.source_repository, profile: contract.portable_profile })),
    profiles: Object.entries(profiles).map(([id, profile]: [string, any]) => ({ id, name: labelFor(id), bundles: profile.bundles || [], workflows: profile.workflows || [], default_chain: profile.default_chain, mutation_policy: profile.mutation_policy })),
    commands: { setup: "./bin/agentctl credentials op setup", doctor: "./bin/agentctl doctor --json", fleet: "./bin/agentctl fleet smoke --json", marketplace: "./bin/agentctl marketplace audit --strict", sync: "./bin/agentctl sync" },
  };
}

const MAX_ACTION_BODY_BYTES = 64 * 1024;

/** The header that carries the page's token on a local action. */
export const TOKEN_HEADER = "x-agent-atlas-token";
const TOKEN_META = '<meta name="agent-atlas-token" content="" />';
const LOOPBACK_NAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const OWN_FETCH_SITES = new Set(["same-origin", "none"]);

/** What a request must match to count as this wizard's own. */
export type Boundary = { port: number; bind: string; allowRemote: boolean; token: string };

function isOwnHost(host: string | undefined, boundary: Boundary): boolean {
  const match = /^(?:\[([0-9a-f:.]+)\]|([a-z0-9._-]+))(?::([0-9]{1,5}))?$/i.exec(host ?? "");
  // A browser leaves the port out of Host only when it is 80.
  if (!match || Number(match[3] ?? 80) !== boundary.port) return false;
  const name = (match[1] ?? match[2]).toLowerCase();
  if (LOOPBACK_NAMES.has(name)) return true;
  // With --allow-remote, an address or the --bind value, but no other name: a page that
  // re-points its own DNS name at this machine arrives under that name.
  return boundary.allowRemote && (isIP(name) !== 0 || name === boundary.bind.toLowerCase());
}

function hasToken(value: string | string[] | undefined, token: string): boolean {
  if (typeof value !== "string") return false;
  const given = Buffer.from(value);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * Why the wizard refuses a request, or null to serve it. Every request must name this
 * server. An /api/ request must not come from another origin. A local action also needs
 * a JSON body, proof that it is same-origin and the token from the page.
 */
export function refusal(method: string, pathname: string, headers: IncomingHttpHeaders, boundary: Boundary): { status: number; message: string } | null {
  if (!isOwnHost(headers.host, boundary)) return { status: 403, message: "The wizard does not answer under this host name" };
  if (!pathname.startsWith("/api/")) return null;
  const own = `http://${headers.host}`.toLowerCase();
  const origin = headers.origin?.toLowerCase();
  const site = headers["sec-fetch-site"] as string | undefined;
  if ((origin !== undefined && origin !== own) || (site !== undefined && !OWN_FETCH_SITES.has(site))) return { status: 403, message: "Requests from another origin are refused" };
  if (method !== "POST" || !pathname.startsWith("/api/action/")) return null;
  if (!/^application\/json\s*(;|$)/i.test(headers["content-type"] ?? "")) return { status: 415, message: "Local actions need a JSON body" };
  if (origin !== own && site !== "same-origin") return { status: 403, message: "Local actions need a same-origin request" };
  if (!hasToken(headers[TOKEN_HEADER], boundary.token)) return { status: 403, message: "Reload the wizard page and try again" };
  return null;
}

/** The page, carrying this server's token for its local actions. */
function page(token: string): string {
  return readFileSync(join(WEB_ROOT, "index.html"), "utf8").replace(TOKEN_META, TOKEN_META.replace('content=""', `content="${token}"`));
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    let size = 0;
    let rejected = false;
    request.on("data", (chunk) => {
      if (rejected) return;
      size += Buffer.byteLength(chunk);
      if (size > MAX_ACTION_BODY_BYTES) {
        rejected = true;
        request.resume();
        rejectBody(new Error(`request body exceeds ${MAX_ACTION_BODY_BYTES} bytes`));
        return;
      }
      body += String(chunk);
    });
    request.on("end", () => resolveBody(body));
    request.on("error", rejectBody);
  });
}

function send(response: ServerResponse, status: number, type: string, body: string, method = "GET"): void {
  // No other page may frame the wizard and collect clicks on its buttons.
  response.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'", "Connection": "close" });
  if (method !== "HEAD") response.end(body);
  else response.end();
}

async function routeCheck(kind: string): Promise<any> {
  if (kind === "backup-plan") return { kind, status: "ok", data: backupPlan() };
  if (kind === "doctor") {
    const checked = await doctor({ json: false });
    return {
      kind,
      status: checked.exitCode === 0 ? "ok" : "error",
      exit_code: checked.exitCode,
      data: redactSecrets(checked.result),
    };
  }
  const script = kind === "fleet" ? "hub-fleet-smoke.rb" : kind === "marketplace" ? "marketplace-audit.rb" : undefined;
  if (!script) return { kind, status: "error", message: "Unknown read-only check" };
  const result = await legacyScriptAsync(script, ["--json"], kind === "doctor" ? 35_000 : 20_000);
  const parsed = (() => { try { return JSON.parse(result.stdout); } catch { return undefined; } })();
  return {
    kind,
    status: result.exitCode === 0 ? "ok" : "error",
    exit_code: result.exitCode,
    ...(result.timedOut ? { timed_out: true } : {}),
    ...(result.errorCode ? { error_code: result.errorCode } : {}),
    ...(parsed ? { data: redactSecrets(parsed) } : { message: safeDetail(result.stdout || result.stderr) || "check failed" }),
  };
}

/**
 * The file a /docs/ request names, or null. It is checked against the docs folder,
 * not the whole checkout, so a link under docs/ cannot lead to another part of it.
 */
export function docsPath(root: string, pathname: string): string | null {
  return safeChildPath(join(root, "docs"), pathname.slice("/docs/".length));
}

async function route(request: IncomingMessage, token: string): Promise<{ status: number; type: string; body: string }> {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (method === "POST" && !url.pathname.startsWith("/api/action/")) return { status: 405, type: "application/json; charset=utf-8", body: json({ status: "error", message: "Only the named local actions accept POST" }) };
  if (url.pathname === "/" || url.pathname === "/index.html") return { status: 200, type: "text/html; charset=utf-8", body: page(token) };
  if (url.pathname === "/api/overview") return { status: 200, type: "application/json; charset=utf-8", body: json(overviewPayload()) };
  if (url.pathname === "/healthz") return { status: 200, type: "application/json; charset=utf-8", body: json({ ok: true, name: APP_NAME, version: APP_VERSION }) };
  if (url.pathname.startsWith("/api/check/")) {
    const result = await routeCheck(url.pathname.slice("/api/check/".length));
    return { status: result.status === "ok" ? 200 : 503, type: "application/json; charset=utf-8", body: json(result) };
  }
  if (url.pathname.startsWith("/docs/")) {
    const candidate = docsPath(ROOT, url.pathname);
    if (!candidate) return { status: 403, type: "text/plain; charset=utf-8", body: "Forbidden\n" };
    if (!existsSync(candidate)) return { status: 404, type: "text/plain; charset=utf-8", body: "Not found\n" };
    return { status: 200, type: contentType(candidate), body: readFileSync(candidate, "utf8") };
  }
  const candidate = safeChildPath(WEB_ROOT, url.pathname);
  if (!candidate) return { status: 403, type: "text/plain; charset=utf-8", body: "Forbidden\n" };
  if (!existsSync(candidate)) return { status: 404, type: "text/plain; charset=utf-8", body: "Not found\n" };
  return { status: 200, type: contentType(candidate), body: readFileSync(candidate) as unknown as string };
}

// The route function above is split into a small request wrapper so POST bodies
// are only read for the two allowlisted local actions.
async function handle(request: IncomingMessage, boundary: Boundary): Promise<{ status: number; type: string; body: string }> {
  const method = request.method || "GET";
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const refused = refusal(method, url.pathname, request.headers, boundary);
  if (refused) {
    request.resume();
    return { status: refused.status, type: "application/json; charset=utf-8", body: json({ status: "error", message: refused.message }) };
  }
  if (url.pathname === "/api/action/render" || url.pathname === "/api/action/backup") {
    if (method !== "POST") return { status: 405, type: "application/json; charset=utf-8", body: json({ status: "error", message: "Use POST for local actions" }) };
    let payload: any = {};
    try {
      payload = JSON.parse(await readBody(request));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("request body exceeds")) {
        return { status: 413, type: "application/json; charset=utf-8", body: json({ status: "error", message: error.message }) };
      }
      payload = {};
    }
    if (payload?.confirm !== true) return { status: 400, type: "application/json; charset=utf-8", body: json({ status: "error", message: "This local action requires explicit confirmation" }) };
    try {
      if (url.pathname.endsWith("/render")) {
        const result = renderArtifacts({ agent: "all" });
        return { status: 200, type: "application/json; charset=utf-8", body: json({ kind: "render", status: "ok", message: `Generated ${result.outputs.length} portable artifacts under ${result.output}`, data: result }) };
      }
      const result = createBackup();
      return { status: 200, type: "application/json; charset=utf-8", body: json({ kind: "backup", status: "ok", message: `Created redacted agent backup: ${result.output}`, data: result }) };
    } catch (error) {
      return { status: 500, type: "application/json; charset=utf-8", body: json({ status: "error", message: safeDetail(error) }) };
    }
  }
  return route(request, boundary.token);
}

function checkAssets(): number {
  const required = ["index.html", "styles.css", "app.js", "assets/ci-common/tokens.css", "assets/ci-common/logo-mark.svg"];
  const missing = required.filter((file) => !existsSync(join(WEB_ROOT, file)));
  if (missing.length) { console.error(`Missing web assets: ${missing.join(", ")}`); return 1; }
  if (!readFileSync(join(WEB_ROOT, "index.html"), "utf8").includes(TOKEN_META)) { console.error("web/index.html lacks the agent-atlas-token placeholder"); return 1; }
  console.log("CI Agent Sync TypeScript web assets passed");
  return 0;
}

export async function startAtlas(args: string[]): Promise<number> {
  const bind = args.includes("--bind") ? args[args.indexOf("--bind") + 1] : "127.0.0.1";
  const portValue = args.includes("--port") ? args[args.indexOf("--port") + 1] : "8787";
  const port = Number(portValue);
  const open = args.includes("--open");
  const quiet = args.includes("--quiet");
  const allowRemote = args.includes("--allow-remote");
  if (args.includes("--help") || args.includes("-h")) {
    console.log("Usage: agent-atlas [--open] [--bind ADDRESS] [--port PORT] [--allow-remote] [--quiet] [--check]");
    return 0;
  }
  if (args.includes("--check")) return checkAssets();
  if (!Number.isInteger(port) || port < 0 || port > 65_535) { console.error(`Invalid port: ${portValue}`); return 2; }
  if (!allowRemote && !["127.0.0.1", "localhost", "::1"].includes(bind)) { console.error("Refusing non-loopback bind without --allow-remote"); return 2; }
  const token = randomBytes(32).toString("base64url");
  const server = createServer(async (request, response) => {
    try {
      const address = server.address();
      const result = await handle(request, { port: typeof address === "object" && address ? address.port : port, bind, allowRemote, token });
      send(response, result.status, result.type, result.body, request.method);
    } catch (error) {
      send(response, 500, "text/plain; charset=utf-8", `CI Agent Sync error: ${safeDetail(error)}\n`, request.method);
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 65_000;
  server.keepAliveTimeout = 5_000;
  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      const onError = (error: Error): void => { server.off("error", onError); rejectListen(error); };
      server.once("error", onError);
      server.listen(port, bind, () => { server.off("error", onError); resolveListen(); });
    });
  } catch (error) {
    console.error(`Could not start CI Agent Sync on ${bind}:${port}: ${safeDetail(error)}`);
    return 1;
  }
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  if (!quiet) console.log(`CI Agent Sync listening at http://${bind}:${actualPort}/`);
  if (open) {
    const openCommand = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const openArgs = process.platform === "win32" ? ["/c", "start", `http://${bind}:${actualPort}/`] : [`http://${bind}:${actualPort}/`];
    spawn(openCommand, openArgs, { stdio: "ignore", detached: true }).unref();
  }
  await new Promise<void>((resolveStop) => {
    const stop = (): void => {
      server.close(() => resolveStop());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
