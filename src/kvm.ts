import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { isoNow, parseArgs, printJson, readYaml } from "./core.ts";

// IP-KVM dongles (NanoKVM and PiKVM) on the tailnet. The probe is read-only:
// it issues plain GETs without credentials and never logs in. Credentials for
// the MCP servers stay in 1Password and reach a client only through `op run`.

export type KvmModel = "nanokvm" | "pikvm";

export type KvmTargetSpec = {
  model: KvmModel;
  tailscale_name?: string;
  controls?: string;
  controls_verified?: boolean;
  enabled?: boolean;
  // Operator exclusions and blocked hosts: probing is fine, device control is not.
  excluded_from_mcp?: boolean;
  notes?: string;
};

export type KvmTargetsFile = { version: number; observed_at?: string; policy?: Record<string, unknown>; targets: Record<string, KvmTargetSpec> };

export type McpState = "enabled_auth_required" | "enabled_unauthenticated" | "disabled_or_blocked" | "not_in_firmware" | "not_reachable" | "unexpected";

export type ProbeRaw = { status: number | null; location?: string; title?: string; error?: string };

export type KvmRow = {
  name: string;
  model: KvmModel;
  controls: string | null;
  controls_verified: boolean;
  enabled: boolean;
  reachable: boolean;
  scheme: "http" | "https" | null;
  product: KvmModel | "unknown" | "unreachable";
  mcp: McpState;
  status: "ok" | "warn" | "error" | "skipped";
  detail: string;
};

const DEFAULT_TIMEOUT_MS = 6_000;

// Pure classification. Kept free of I/O so the tests can pin the mapping.

export function classifyNanoKvmMcp(status: number | null): McpState {
  if (status === null) return "not_reachable";
  if (status === 401) return "enabled_auth_required";
  if (status === 200) return "enabled_unauthenticated";
  if (status === 403) return "disabled_or_blocked";
  if (status === 404) return "not_in_firmware";
  return "unexpected";
}

export function classifyProduct(input: { rootStatus: number | null; rootTitle?: string; redirectsToLogin?: boolean; apiInfoStatus?: number | null }): KvmRow["product"] {
  if (input.rootStatus === null) return "unreachable";
  if (input.rootTitle && /nanokvm/i.test(input.rootTitle)) return "nanokvm";
  if (input.redirectsToLogin || input.apiInfoStatus === 401) return "pikvm";
  return "unknown";
}

export function envName(target: string): string {
  return target.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export function nanoKvmKeyEnv(target: string): string {
  return `NANOKVM_${envName(target)}_API_KEY`;
}

export function onePasswordItem(target: string): string {
  return `agent-configs-kvm-${target}`;
}

export function rowStatus(row: Pick<KvmRow, "enabled" | "product" | "mcp" | "model">): { status: KvmRow["status"]; detail: string } {
  if (!row.enabled) return { status: "skipped", detail: "disabled in integrations/kvm/targets.yaml" };
  if (row.product === "unreachable") return { status: "error", detail: "no HTTP answer on the tailnet name" };
  if (row.model === "pikvm") {
    return row.product === "pikvm"
      ? { status: "ok", detail: "PiKVM API reachable; authenticate through PIKVM_* env from 1Password" }
      : { status: "warn", detail: `answers, but the product did not match PiKVM (seen: ${row.product})` };
  }
  if (row.product !== "nanokvm") return { status: "warn", detail: `answers, but the product did not match NanoKVM (seen: ${row.product})` };
  if (row.mcp === "enabled_auth_required") return { status: "ok", detail: "MCP endpoint is on and requires a key" };
  if (row.mcp === "enabled_unauthenticated") return { status: "warn", detail: "MCP answers without a key; review before any client uses it" };
  if (row.mcp === "disabled_or_blocked") return { status: "warn", detail: "MCP is off or blocked; enable the MCP switch on the device" };
  if (row.mcp === "not_in_firmware") return { status: "warn", detail: "no MCP route; update the NanoKVM firmware and app" };
  return { status: "warn", detail: `unexpected MCP response (${row.mcp})` };
}

// I/O. GET only, bounded by a timeout, body capped so a page cannot balloon.

function get(url: string, timeoutMs: number): Promise<ProbeRaw> {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const send = parsed.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || undefined,
      path: `${parsed.pathname}${parsed.search}`,
      method: "GET",
      timeout: timeoutMs,
      // Self-signed certificates are normal on these devices. The probe reads
      // only the status line and the page title; it sends no secret.
      rejectUnauthorized: false,
      headers: { "user-agent": "ci-agent-sync-kvm-probe/1" },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { if (body.length < 4_096) body += chunk; });
      res.on("end", () => {
        const title = body.match(/<title>([^<]{0,120})<\/title>/i)?.[1]?.trim();
        resolve({ status: res.statusCode ?? null, location: res.headers.location ? String(res.headers.location) : undefined, title });
      });
      res.on("error", (error) => resolve({ status: null, error: error.message }));
    });
    req.on("timeout", () => { req.destroy(); resolve({ status: null, error: `timed out after ${timeoutMs / 1000}s` }); });
    req.on("error", (error) => resolve({ status: null, error: error.message }));
    req.end();
  });
}

export function loadKvmTargets(): KvmTargetsFile {
  return readYaml<KvmTargetsFile>(join("integrations", "kvm", "targets.yaml"));
}

async function probeTarget(name: string, spec: KvmTargetSpec, timeoutMs: number): Promise<KvmRow> {
  const host = spec.tailscale_name || name;
  const base = { name, model: spec.model, controls: spec.controls ?? null, controls_verified: Boolean(spec.controls_verified), enabled: spec.enabled !== false };
  if (!base.enabled) {
    return { ...base, reachable: false, scheme: null, product: "unreachable", mcp: "not_reachable", ...rowStatus({ enabled: false, product: "unreachable", mcp: "not_reachable", model: spec.model }) };
  }
  let scheme: "http" | "https" = "http";
  let root = await get(`http://${host}/`, timeoutMs);
  if (root.status !== null && [301, 302, 307, 308].includes(root.status) && root.location?.startsWith("https://")) {
    scheme = "https";
    root = await get(`https://${host}/`, timeoutMs);
  } else if (root.status === null) {
    const tls = await get(`https://${host}/`, timeoutMs);
    if (tls.status !== null) { scheme = "https"; root = tls; }
  }
  if (root.status === null) {
    return { ...base, reachable: false, scheme: null, product: "unreachable", mcp: "not_reachable", ...rowStatus({ enabled: true, product: "unreachable", mcp: "not_reachable", model: spec.model }), detail: `no answer: ${root.error ?? "unknown error"}` };
  }
  const base_url = `${scheme}://${host}`;
  const redirectsToLogin = root.location?.includes("/login") ?? false;
  const apiInfo = spec.model === "pikvm" ? await get(`${base_url}/api/info`, timeoutMs) : null;
  const product = classifyProduct({ rootStatus: root.status, rootTitle: root.title, redirectsToLogin, apiInfoStatus: apiInfo?.status ?? null });
  const mcpRaw = spec.model === "nanokvm" ? await get(`${base_url}/api/mcp`, timeoutMs) : null;
  const mcp: McpState = spec.model === "pikvm" ? (apiInfo?.status === 401 || apiInfo?.status === 200 ? "enabled_auth_required" : "not_reachable") : classifyNanoKvmMcp(mcpRaw?.status ?? null);
  const verdict = rowStatus({ enabled: true, product, mcp, model: spec.model });
  return { ...base, reachable: true, scheme, product, mcp, ...verdict };
}

export async function kvmStatus(options: { timeoutMs?: number } = {}): Promise<{ schema_version: number; observed_at: string; summary: Record<string, number>; rows: KvmRow[] }> {
  const file = loadKvmTargets();
  const rows: KvmRow[] = [];
  for (const [name, spec] of Object.entries(file.targets)) rows.push(await probeTarget(name, spec, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const summary = { ok: rows.filter((r) => r.status === "ok").length, warn: rows.filter((r) => r.status === "warn").length, error: rows.filter((r) => r.status === "error").length, skipped: rows.filter((r) => r.status === "skipped").length };
  return { schema_version: 1, observed_at: isoNow(), summary, rows };
}

export function mcpSnippet(name: string, spec: KvmTargetSpec, scheme: "http" | "https" = "http"): string {
  if (spec.model !== "nanokvm") throw new Error("mcp snippets are generated for NanoKVM targets; PiKVM uses the stdio server in registry.yaml");
  const host = spec.tailscale_name || name;
  const server = `nanokvm-${name}`;
  // Shape follows the Sipeed NanoKVM MCP guide (OpenCode example). The URL and
  // key must be copied from the device's own MCP page; the placeholder below is
  // resolved from the environment by `op run`, never written to disk.
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    mcp: { [server]: { type: "remote", url: `${scheme}://${host}/api/mcp`, oauth: false, headers: { Authorization: `Bearer \${${nanoKvmKeyEnv(name)}}` } } },
  }, null, 2);
}

function usage(): void {
  console.log(`agentctl kvm — read-only IP-KVM checks and MCP wiring

Usage:
  agentctl kvm status [--json] [--strict] [--timeout SECONDS]
  agentctl kvm targets [--json]
  agentctl kvm mcp <target> [--client opencode] [--scheme http|https]

Notes:
  status    GET-only probe over the tailnet. No credentials are sent.
  mcp       prints a client config with \${ENV} placeholders. Keys come from
            1Password via: op run --env-file local/kvm.env -- <client>
`);
}

export async function kvmCommand(args: string[]): Promise<number> {
  const target = args.shift() || "help";
  const parsed = parseArgs(args);
  if (target === "help" || target === "--help") { usage(); return 0; }
  if (target === "targets") {
    const file = loadKvmTargets();
    if (parsed.flags.has("--json")) printJson(file.targets);
    else for (const [name, spec] of Object.entries(file.targets)) console.log(`${name}\t${spec.model}\tcontrols=${spec.controls ?? "unknown"}\tenabled=${spec.enabled !== false}`);
    return 0;
  }
  if (target === "status") {
    const timeoutMs = Math.max(1, Math.min(Number(parsed.values.get("--timeout") || 6), 60)) * 1_000;
    const result = await kvmStatus({ timeoutMs });
    if (parsed.flags.has("--json")) printJson(result);
    else {
      for (const row of result.rows) {
        const mark = row.status === "ok" ? "✓" : row.status === "warn" ? "!" : row.status === "skipped" ? "-" : "✗";
        console.log(`${mark} ${row.name} [${row.model}] ${row.scheme ?? "-"} product=${row.product} mcp=${row.mcp} — ${row.detail}`);
      }
      console.log(`Summary: ${result.summary.ok} ok, ${result.summary.warn} warnings, ${result.summary.error} errors, ${result.summary.skipped} skipped`);
    }
    if (result.summary.error > 0) return 1;
    return parsed.flags.has("--strict") && result.summary.warn > 0 ? 2 : 0;
  }
  if (target === "mcp") {
    const name = parsed.positional[0];
    const file = loadKvmTargets();
    const spec = name ? file.targets[name] : undefined;
    if (!name || !spec) { console.error(`unknown KVM target: ${name ?? "(none)"}; run agentctl kvm targets`); return 2; }
    if (spec.excluded_from_mcp) { console.error(`${name} is excluded from MCP control by operator policy; see integrations/kvm/targets.yaml`); return 2; }
    const client = parsed.values.get("--client") || "opencode";
    if (client !== "opencode") { console.error("only the opencode snippet is generated; other clients need their own review"); return 2; }
    const scheme = parsed.values.get("--scheme") === "https" ? "https" : "http";
    console.log(mcpSnippet(name, spec, scheme));
    console.error(`# key item: ${onePasswordItem(name)} (field: credential), env: ${nanoKvmKeyEnv(name)}`);
    return 0;
  }
  console.error(`unknown kvm command: ${target}`);
  usage();
  return 2;
}
