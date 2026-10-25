import { existsSync, mkdirSync } from "node:fs";
import { hostname, platform as nodePlatform } from "node:os";
import { join } from "node:path";
import {
  HOME,
  ROOT,
  commandPath,
  directoryExists,
  expandPath,
  isoNow,
  parseArgs,
  parsePayload,
  platformName,
  readYaml,
  redactSecrets,
  runCommand,
  safeDetail,
  sha256,
  writeJson,
} from "./core.ts";

type Status = "ok" | "warn" | "error" | "info";
type JsonRecord = Record<string, unknown>;

export type PlatformCheck = {
  id: string;
  status: Status;
  detail: string;
  [key: string]: unknown;
};

type RepoEvidence = {
  name: string;
  path: string;
  present: boolean;
  default_branch?: string;
  commit?: string | null;
  branch?: string | null;
  dirty?: boolean;
  dirty_file_count?: number;
  ahead?: number | null;
  behind?: number | null;
  origin_present?: boolean;
};

type EndpointEvidence = {
  id: string;
  base_url: string;
  path: string;
  status: Status;
  http_status: number | null;
  detail: string;
  duration_ms: number;
};

type TailscaleEvidence = {
  available: boolean;
  self?: { hostname: string | null; dns_name: string | null; online: boolean | null; ips: string[] };
  peers: Array<{ hostname: string | null; dns_name: string | null; online: boolean | null; os: string | null; ips: string[] }>;
  summary: { online: number; offline: number; unknown: number };
};

type RepoDefinition = { name: string; default_branch: string; local_path: string };

export type PlatformPreflightResult = {
  schema_version: 1;
  generated_at: string;
  command: "platform preflight";
  read_only: true;
  secrets_redacted: true;
  machine: { hostname: string; platform: string; platform_name: string; node: string };
  summary: { ok: number; warn: number; error: number; info: number };
  checks: PlatformCheck[];
  repositories: RepoEvidence[];
  services: EndpointEvidence[];
  tailscale: TailscaleEvidence;
  fingerprints: Record<string, string | null>;
  promotion_gate?: JsonRecord;
};

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function add(checks: PlatformCheck[], id: string, status: Status, detail: string, extra: JsonRecord = {}): void {
  checks.push({ id, status, detail, ...extra });
}

function commandJson(command: string, args: string[], cwd = ROOT, timeoutMs = 15_000): { result: ReturnType<typeof runCommand>; payload: unknown } {
  const result = runCommand(command, args, { cwd, timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  return { result, payload: parsePayload(result.stdout) };
}

function commandText(command: string, args: string[], cwd: string, timeoutMs = 5_000): string | null {
  const result = runCommand(command, args, { cwd, timeoutMs, maxBuffer: 64 * 1024 });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

function gitFacts(repoPath: string, defaultBranch: string): RepoEvidence {
  const base = { name: repoPath.split("/").at(-1) || repoPath, path: repoPath, present: false, default_branch: defaultBranch } satisfies RepoEvidence;
  if (!existsSync(join(repoPath, ".git"))) return base;

  const root = commandText("git", ["-C", repoPath, "rev-parse", "--show-toplevel"], repoPath);
  if (!root) return base;

  const commit = commandText("git", ["-C", repoPath, "rev-parse", "HEAD"], repoPath);
  const branch = commandText("git", ["-C", repoPath, "branch", "--show-current"], repoPath);
  const dirtyFiles = commandText("git", ["-C", repoPath, "status", "--porcelain=v1", "--untracked-files=all"], repoPath)
    ?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) || [];
  const originRef = `origin/${defaultBranch}`;
  const originCommit = commandText("git", ["-C", repoPath, "rev-parse", "--verify", originRef], repoPath);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (originCommit) {
    const counts = commandText("git", ["-C", repoPath, "rev-list", "--left-right", "--count", `HEAD...${originRef}`], repoPath);
    const parsed = counts?.split(/\s+/).map(Number);
    if (parsed?.length === 2 && parsed.every(Number.isFinite)) [ahead, behind] = parsed;
  }

  return {
    ...base,
    present: true,
    commit,
    branch: branch || null,
    dirty: dirtyFiles.length > 0,
    dirty_file_count: dirtyFiles.length,
    ahead,
    behind,
    origin_present: Boolean(originCommit),
  };
}

function workspaceRoot(): string {
  const profile = join(ROOT, "profiles", "machines", "local.yaml");
  try {
    const config = existsSync(profile) ? readYaml<JsonRecord>(profile) : {};
    const paths = isRecord(config.paths) ? config.paths : {};
    return process.env.CI_ROOT || expandPath(stringValue(paths.ci_root) || join(HOME, "devel", "ci"));
  } catch {
    return process.env.CI_ROOT || join(HOME, "devel", "ci");
  }
}

function resolveRepositoryPath(name: string, configuredPath: string, ciRoot: string): string {
  const explicit: Record<string, string | undefined> = {
    "Companion-Memory": process.env.CI_MEMORY_ROOT,
    "Companion-Hub": process.env.CI_HUB_ROOT,
    "CI-Engineering": process.env.CI_ENGINEERING_ROOT,
    "CI-Portal": process.env.CI_PORTAL_ROOT,
    "CI-Marketplace": process.env.CI_MARKETPLACE_ROOT,
  };
  const candidates = [
    explicit[name],
    configuredPath,
    name === "Companion-Hub" ? join(ciRoot, "0-HUB", "Companion-Hub") : undefined,
    name === "CI-Engineering" ? join(ciRoot, "0-HUB", "CI-Engineering") : undefined,
    name === "CI-Portal" ? join(ciRoot, "0-HUB", "CI-Portal") : undefined,
    name === "CI-Marketplace" ? join(ciRoot, "ci-market-apps", "CI-Marketplace") : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  // A linked worktree has a `.git` file rather than a `.git` directory. Both
  // are valid checkouts for evidence collection, so use existence here and
  // let `gitFacts` perform the real repository probe.
  return candidates.find((candidate) => existsSync(join(candidate, ".git"))) || candidates[0] || configuredPath;
}

function repositoryDefinitions(ciRoot: string): RepoDefinition[] {
  try {
    const manifest = readYaml<JsonRecord>(join(ROOT, "repos", "companionintelligence.yaml"));
    const raw = Array.isArray(manifest.repositories) ? manifest.repositories : [];
    return raw.filter(isRecord).flatMap((repo) => {
      const name = stringValue(repo.name);
      const defaultBranch = stringValue(repo.default_branch) || "main";
      const localPath = stringValue(repo.local_path);
      if (!name || !localPath) return [];
      const expanded = expandPath(localPath, ciRoot);
      return [{ name, default_branch: defaultBranch, local_path: resolveRepositoryPath(name, expanded, ciRoot) }];
    });
  } catch {
    return [];
  }
}

function fileFingerprint(relativePath: string): string | null {
  const file = join(ROOT, relativePath);
  try {
    return existsSync(file) ? sha256(file) : null;
  } catch {
    return null;
  }
}

function normalizePeer(value: unknown): { hostname: string | null; dns_name: string | null; online: boolean | null; os: string | null; ips: string[] } {
  const peer = isRecord(value) ? value : {};
  const ips = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs.filter((ip): ip is string => typeof ip === "string") : [];
  return {
    hostname: stringValue(peer.HostName) || null,
    dns_name: stringValue(peer.DNSName) || null,
    online: typeof peer.Online === "boolean" ? peer.Online : null,
    os: stringValue(peer.OS) || null,
    ips,
  };
}

export function summarizeTailscaleStatus(payload: unknown): TailscaleEvidence {
  if (!isRecord(payload)) return { available: false, peers: [], summary: { online: 0, offline: 0, unknown: 0 } };
  const self = normalizePeer(payload.Self);
  const peerMap = isRecord(payload.Peer) ? Object.values(payload.Peer) : [];
  const peers = peerMap.map(normalizePeer).sort((a, b) => (a.hostname || "").localeCompare(b.hostname || ""));
  const all = [self, ...peers];
  return {
    available: true,
    self: { hostname: self.hostname, dns_name: self.dns_name, online: self.online, ips: self.ips },
    peers,
    summary: {
      online: all.filter((peer) => peer.online === true).length,
      offline: all.filter((peer) => peer.online === false).length,
      unknown: all.filter((peer) => peer.online == null).length,
    },
  };
}

async function probeEndpoint(id: string, baseUrl: string, paths: string[]): Promise<EndpointEvidence> {
  const startedAt = Date.now();
  const cleanBase = baseUrl.replace(/\/$/, "");
  let lastCode: number | null = null;
  let lastPath = paths.at(-1) || "/";
  let lastDetail = "unreachable";
  for (const path of paths) {
    lastPath = path;
    try {
      const url = new URL(path.replace(/^\//, ""), `${cleanBase}/`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3_000);
      try {
        const response = await fetch(url, { signal: controller.signal });
        lastCode = response.status;
        lastDetail = response.status === 401 || response.status === 403
          ? "reachable; authentication is required"
          : `HTTP ${response.status}`;
        if (response.status === 404 && path !== paths.at(-1)) continue;
        const status: Status = response.status >= 200 && response.status < 400 ? "ok" : response.status === 401 || response.status === 403 ? "warn" : "warn";
        return { id, base_url: cleanBase, path, status, http_status: response.status, detail: lastDetail, duration_ms: Date.now() - startedAt };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      lastDetail = error instanceof Error ? `unreachable: ${error.name}` : "unreachable";
    }
  }
  return { id, base_url: cleanBase, path: lastPath, status: "warn", http_status: lastCode, detail: lastDetail, duration_ms: Date.now() - startedAt };
}

function localEndpoint(name: string, fallback: string): string {
  const profile = join(ROOT, "profiles", "machines", "local.yaml");
  try {
    const config = existsSync(profile) ? readYaml<JsonRecord>(profile) : {};
    const endpoints = isRecord(config.endpoints) ? config.endpoints : {};
    const services = isRecord(config.services) ? config.services : {};
    return process.env[name] || stringValue(endpoints[name]) || stringValue(services[name]) || fallback;
  } catch {
    return process.env[name] || fallback;
  }
}

function parsePromotionOutput(stdout: string): JsonRecord | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  const direct = parsePayload(trimmed);
  if (isRecord(direct)) return direct;
  const starts = [...trimmed.matchAll(/(?:^|\n)(\{)/g)].map((match) => match.index ?? -1).filter((index) => index >= 0);
  for (const start of starts.reverse()) {
    const candidate = parsePayload(trimmed.slice(start));
    if (isRecord(candidate)) return candidate;
  }
  return undefined;
}

function promotionEvidence(ciRoot: string): JsonRecord | undefined {
  const marketplace = resolveRepositoryPath("CI-Marketplace", join(ciRoot, "CI-Marketplace"), ciRoot);
  const deno = commandPath("deno");
  if (!deno || !directoryExists(marketplace)) return undefined;
  const { result } = commandJson(deno, ["task", "promotion-gate", "--", "--json"], marketplace, 60_000);
  const payload = parsePromotionOutput(result.stdout);
  if (payload) {
    const findings = Array.isArray(payload.findings) ? payload.findings.filter(isRecord) : [];
    const findingCounts = Object.fromEntries([...new Set(findings.map((finding) => stringValue(finding.code)).filter((code): code is string => Boolean(code)))].sort().map((code) => [code, findings.filter((finding) => finding.code === code).length]));
    return {
      decision: stringValue(payload.decision) || "unknown",
      mode: stringValue(payload.mode) || "unknown",
      candidateCount: numberValue(payload.candidateCount),
      passedCount: numberValue(payload.passedCount),
      blockedCount: numberValue(payload.blockedCount),
      finding_counts: findingCounts,
      command_exit_code: result.exitCode,
      working_directory: marketplace,
    };
  }
  return {
    decision: "unavailable",
    command_exit_code: result.exitCode,
    working_directory: marketplace,
    detail: safeDetail(result.stderr || result.stdout) || "promotion gate returned no JSON",
  };
}

function summarize(checks: PlatformCheck[]): PlatformPreflightResult["summary"] {
  return {
    ok: checks.filter((check) => check.status === "ok").length,
    warn: checks.filter((check) => check.status === "warn").length,
    error: checks.filter((check) => check.status === "error").length,
    info: checks.filter((check) => check.status === "info").length,
  };
}

export async function platformPreflight(options: { strict?: boolean } = {}): Promise<{ exitCode: number; result: PlatformPreflightResult }> {
  const checks: PlatformCheck[] = [];
  const ciRoot = workspaceRoot();
  const definitions = repositoryDefinitions(ciRoot);
  const repositories = definitions.map((repo) => ({ ...gitFacts(repo.local_path, repo.default_branch), name: repo.name, path: repo.local_path }));

  for (const repo of repositories) {
    if (!repo.present) add(checks, `repo.${repo.name}`, "warn", "checkout missing", { path: repo.path });
    else if (repo.dirty) add(checks, `repo.${repo.name}`, "warn", `${repo.dirty_file_count || 0} dirty file(s)`, { path: repo.path, commit: repo.commit });
    else if (repo.behind && repo.behind > 0) add(checks, `repo.${repo.name}`, "warn", `${repo.behind} commit(s) behind origin/${repo.default_branch}`, { path: repo.path, commit: repo.commit });
    else add(checks, `repo.${repo.name}`, "ok", `clean at ${repo.commit || "unknown"}`, { path: repo.path, commit: repo.commit });
  }

  const serviceDefinitions: Array<{ id: string; base: string; paths: string[] }> = [
    { id: "runtime.omlx", base: process.env.OMLX_BASE_URL || "http://127.0.0.1:8000", paths: ["/health", "/v1/models"] },
    { id: "runtime.ollama", base: process.env.OLLAMA_HOST || "http://127.0.0.1:11434", paths: ["/api/tags"] },
    { id: "runtime.omniroute", base: process.env.OMNIROUTE_BASE_URL || "http://127.0.0.1:20128", paths: ["/v1/models"] },
    { id: "runtime.openclaw", base: "http://127.0.0.1:18789", paths: ["/health"] },
    { id: "runtime.companion-hub", base: localEndpoint("COMPANION_HUB_BASE_URL", "http://127.0.0.1:5002"), paths: ["/api/health", "/health"] },
    { id: "runtime.companion-memory", base: localEndpoint("COMPANION_MEMORY_BASE_URL", "http://127.0.0.1:3030"), paths: ["/api/health", "/health"] },
  ];
  const services = await Promise.all(serviceDefinitions.map((service) => probeEndpoint(service.id, service.base, service.paths)));
  for (const service of services) add(checks, service.id, service.status, `${service.path} ${service.detail}`, { http_status: service.http_status, duration_ms: service.duration_ms });

  // The HTTP liveness route only proves that the process is listening. Ask the
  // same Node-backed launcher used by harness-smoke for the gateway's own
  // dependency-aware health response so a live-but-broken desktop runtime is
  // not reported as fully healthy.
  const openclawLauncher = join(ROOT, "bin", "openclaw-runtime");
  if (existsSync(openclawLauncher)) {
    const { result: gatewayResult, payload: gatewayPayload } = commandJson(openclawLauncher, ["gateway", "health", "--json"], ROOT, 15_000);
    const gatewayStatus = isRecord(gatewayPayload) ? stringValue(gatewayPayload.status) : undefined;
    const gatewayOk = gatewayResult.exitCode === 0 && isRecord(gatewayPayload) && gatewayPayload.ok === true;
    add(checks, "runtime.openclaw-gateway", gatewayOk ? "ok" : "warn", gatewayOk
      ? `gateway ${gatewayStatus || "healthy"}`
      : safeDetail(gatewayResult.stderr || gatewayResult.stdout) || "gateway health failed",
    { status_value: gatewayStatus || null, duration_ms: gatewayResult.durationMs });
  } else {
    add(checks, "runtime.openclaw-gateway", "warn", "Node-backed OpenClaw launcher is missing");
  }

  const op = commandPath(process.env.AGENT_CONFIGS_OP_BINARY || "op");
  if (!op) add(checks, "credential-backend.onepassword", "warn", "1Password CLI is not installed");
  else {
    const { result } = commandJson(op, ["vault", "list", "--format=json"], ROOT, 5_000);
    add(checks, "credential-backend.onepassword", result.exitCode === 0 ? "ok" : "warn", result.exitCode === 0 ? "authenticated; values are never printed" : "installed but not authenticated");
  }

  const tailscaleCommand = commandPath("tailscale");
  let tailscale: TailscaleEvidence;
  if (!tailscaleCommand) {
    tailscale = { available: false, peers: [], summary: { online: 0, offline: 0, unknown: 0 } };
    add(checks, "fleet.tailscale", "warn", "tailscale CLI is not installed");
  } else {
    const { result, payload } = commandJson(tailscaleCommand, ["status", "--json"], ROOT, 10_000);
    tailscale = summarizeTailscaleStatus(payload);
    if (result.exitCode === 0 && tailscale.available) {
      add(checks, "fleet.tailscale", "ok", `${tailscale.summary.online} online, ${tailscale.summary.offline} offline, ${tailscale.peers.length} peers`);
    } else add(checks, "fleet.tailscale", "warn", safeDetail(result.stderr || result.stdout) || "tailscale status unavailable");
  }

  const promotion = promotionEvidence(ciRoot);
  if (promotion) {
    const decision = stringValue(promotion.decision) || "unknown";
    add(checks, "release.marketplace-promotion", decision === "pass" || decision === "ready" ? "ok" : "warn", `promotion gate: ${decision}`, { candidate_count: promotion.candidateCount, blocked_count: promotion.blockedCount });
  } else add(checks, "release.marketplace-promotion", "info", "Marketplace checkout or Deno promotion gate unavailable; run it in the Marketplace checkout");

  const fingerprints: Record<string, string | null> = {
    store: commandText("git", ["rev-parse", "HEAD"], ROOT),
    provider_profile: fileFingerprint("providers/providers.yaml"),
    model_profile: fileFingerprint("integrations/models.yaml"),
    fleet_targets: fileFingerprint("integrations/fleet/targets.yaml"),
    mcp_registry: fileFingerprint("integrations/mcp/registry.yaml"),
  };
  const summary = summarize(checks);
  const result: PlatformPreflightResult = {
    schema_version: 1,
    generated_at: isoNow(),
    command: "platform preflight",
    read_only: true,
    secrets_redacted: true,
    machine: { hostname: hostname(), platform: nodePlatform(), platform_name: platformName(), node: process.version },
    summary,
    checks,
    repositories,
    services,
    tailscale,
    fingerprints,
    ...(promotion ? { promotion_gate: redactSecrets(promotion) as JsonRecord } : {}),
  };
  const exitCode = summary.error > 0 || (options.strict && summary.warn > 0) ? 1 : 0;
  return { exitCode, result };
}

function evidenceOutput(value: string | undefined): string {
  if (value) return expandPath(value);
  return join(ROOT, "local", "evidence", new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14));
}

export async function platformCommand(args: string[]): Promise<number> {
  const target = args[0] || "preflight";
  const parsed = parseArgs(args.slice(1));
  if (!["preflight", "evidence"].includes(target)) {
    console.error("Usage: agentctl platform preflight|evidence [--json] [--strict] [--output PATH]");
    return 2;
  }
  const preflight = await platformPreflight({ strict: parsed.flags.has("--strict") });
  if (target === "preflight") {
    if (parsed.flags.has("--json")) process.stdout.write(`${JSON.stringify(preflight.result, null, 2)}\n`);
    else {
      console.log("CI Agent Sync platform preflight (read-only)");
      for (const check of preflight.result.checks) console.log(`${check.status === "ok" ? "✓" : check.status === "error" ? "✗" : check.status === "info" ? "·" : "!"} ${check.id}: ${check.detail}`);
      console.log(`Summary: ${preflight.result.summary.ok} ok, ${preflight.result.summary.warn} warnings, ${preflight.result.summary.error} errors`);
    }
    return preflight.exitCode;
  }

  const output = evidenceOutput(parsed.values.get("--output"));
  mkdirSync(output, { recursive: true });
  const preflightPath = join(output, "preflight.json");
  writeJson(preflightPath, preflight.result);
  const manifest = {
    schema_version: 1,
    generated_at: preflight.result.generated_at,
    redacted: true,
    read_only: true,
    source_commit: preflight.result.fingerprints.store,
    input_fingerprints: preflight.result.fingerprints,
    repository_commits: Object.fromEntries(preflight.result.repositories.filter((repo) => repo.commit).map((repo) => [repo.name, repo.commit])),
    artifacts: [{ path: "preflight.json", sha256: sha256(preflightPath) }],
  };
  writeJson(join(output, "manifest.json"), manifest);
  const response = { ...preflight.result, evidence_directory: output, evidence_manifest: join(output, "manifest.json") };
  if (parsed.flags.has("--json")) process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
  else console.log(`Wrote redacted platform evidence to ${output}`);
  return preflight.exitCode;
}
