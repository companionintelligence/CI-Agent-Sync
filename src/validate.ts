import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, fileExists, readJson, readText, readYaml } from "./core.ts";
import type { DecodeResult } from "./spec-registry.ts";
import { POLICY_FILE, TOOLCHAINS_FILE, activeTools, compareVersions, hideHome, policyProblems, readToolchains } from "./toolchains.ts";

type Check = { id: string; status: "ok" | "error"; detail: string };

/** Registries that validate decodes: the shipped template and this repository's own. */
export const VERIFICATION_REGISTRIES = [
  { id: "example", file: "integrations/verification/specs.toml.example" },
  { id: "repository", file: ".agent-configs/specs.toml" },
] as const;

export type VerificationVocabulary = {
  readonly tools: ReadonlyArray<string>;
  readonly kinds: ReadonlyArray<string>;
  readonly gates: ReadonlyArray<string>;
  readonly statuses: ReadonlyArray<string>;
};

/**
 * Cross-checks for integrations/verification: toolchain ids are unique and well formed,
 * the policy names only known tools, and every registry decodes and requires only known
 * toolchains. Pure, so the tests can feed it broken input.
 */
export function verificationChecks(input: {
  toolchains: unknown;
  policy: unknown;
  registries: ReadonlyArray<{ id: string; file: string; text: string }>;
  decode: (text: string) => DecodeResult;
  vocabulary: VerificationVocabulary;
}): Check[] {
  const checks: Check[] = [];
  const { toolchains, problems } = readToolchains(input.toolchains, input.vocabulary.tools);
  const known = new Set(toolchains.map((toolchain) => toolchain.id));
  const byId = new Map<string, string[]>();
  for (const problem of problems) byId.set(problem.id, [...(byId.get(problem.id) || []), problem.message]);
  for (const toolchain of toolchains) add(checks, `verification.toolchain.${toolchain.id}`, "ok", `${toolchain.kind}, ring ${toolchain.ring}, ${toolchain.version ? `pinned ${toolchain.version}` : toolchain.minimum ? `minimum ${toolchain.minimum}` : "no minimum"}`);
  for (const [id, messages] of byId) add(checks, `verification.toolchain.${id}`, "error", messages.join("; "));
  const policy = policyProblems(input.policy, { ...input.vocabulary, tools: activeTools(toolchains) });
  if (policy.length === 0) add(checks, "verification.policy", "ok", "names only known tools, kinds, gates and statuses");
  for (const problem of policy) add(checks, `verification.policy.${problem.id}`, "error", problem.message);
  for (const registry of input.registries) {
    const decoded = input.decode(registry.text);
    if (!decoded.ok) {
      add(checks, `verification.registry.${registry.id}`, "error", `${registry.file}: ${decoded.issues.map((issue) => `${issue.path || "(root)"}: ${issue.message}`).join("; ")}`);
      continue;
    }
    const entries = decoded.registry.spec ?? [];
    add(checks, `verification.registry.${registry.id}`, "ok", `${registry.file} decodes (${entries.length} ${entries.length === 1 ? "entry" : "entries"})`);
    const unknown = entries.flatMap((entry, index) => (entry.requires ?? []).filter((id) => !known.has(id)).map((id) => `spec[${index}].requires: "${id}" is not a toolchain id`));
    if (unknown.length > 0) add(checks, `verification.registry.${registry.id}.requires`, "error", unknown.join("; "));
  }
  return checks;
}

/**
 * Why the registry decoder did not load. Effect 4 states support for Node.js 22.19 or
 * later, so an older Node.js is named as the likely cause.
 */
export function decoderLoadProblem(error: unknown): string {
  const message = hideHome((error instanceof Error ? error.message : String(error)).split("\n", 1)[0].replace(/\.$/u, ""));
  const node = process.versions.node;
  const old = compareVersions(node, "22.19.0") < 0 ? ` Effect 4 states support for Node.js 22.19 or later, and this is Node.js ${node}.` : "";
  return `could not load the spec registry decoder (Effect): ${message}.${old}`;
}

function filesUnder(relativeRoot: string, extension: string): string[] {
  const root = join(ROOT, relativeRoot);
  try {
    const entries = readdirSync(root, { withFileTypes: true });
    return entries.flatMap((entry) => {
      const child = join(relativeRoot, entry.name);
      if (entry.isDirectory()) return filesUnder(child, extension);
      return child.endsWith(extension) ? [child] : [];
    });
  } catch {
    return [];
  }
}

function add(checks: Check[], id: string, status: Check["status"], detail: string): void {
  checks.push({ id, status, detail });
}

export async function validateStore(options: { json?: boolean } = {}): Promise<{ exitCode: number; result: any }> {
  const checks: Check[] = [];
  const yamlFiles = ["integrations", "profiles", "repos", "sync", "providers"].flatMap((root) => filesUnder(root, ".yaml"));
  for (const file of yamlFiles) {
    try { readYaml(file); add(checks, `yaml.${file}`, "ok", "parses"); }
    catch (error) { add(checks, `yaml.${file}`, "error", String(error)); }
  }
  const jsonFiles = ["integrations", "agents"].flatMap((root) => filesUnder(root, ".json"));
  for (const file of jsonFiles) {
    try { readJson(file); add(checks, `json.${file}`, "ok", "parses"); }
    catch (error) { add(checks, `json.${file}`, "error", String(error)); }
  }

  try {
    const providers = readYaml<any>("providers/providers.yaml").providers || {};
    const onePassword = readYaml<any>("providers/onepassword.yaml");
    const models = readYaml<any>("integrations/models.yaml");
    const routing = readYaml<any>("integrations/providers/routing.yaml");
    const fallback = readYaml<any>("integrations/providers/fallbacks.yaml");
    const bundles = readYaml<any>("integrations/capability-bundles.yaml");
    const harnesses = readYaml<any>("integrations/harnesses.yaml").harnesses || {};
    const marketplace = readYaml<any>("integrations/marketplace-harnesses.yaml").harnesses || {};
    const registry = readYaml<any>("integrations/mcp/registry.yaml").servers || {};
    for (const name of Object.keys(fallback.providers || {})) add(checks, `reference.provider.${name}`, providers[name] ? "ok" : "error", providers[name] ? "declared" : "missing from providers/providers.yaml");
    for (const [chainName, chain] of Object.entries(fallback.chains || {})) for (const step of (chain as any).steps || []) add(checks, `reference.chain.${chainName}.${step.provider}`, providers[step.provider] ? "ok" : "error", providers[step.provider] ? "provider is declared" : "provider is missing");
    for (const [name, server] of Object.entries(registry)) for (const client of [...(server as any).clients || [], ...(server as any).optional_clients || []].filter((value, index, values) => values.indexOf(value) === index)) add(checks, `reference.mcp.${name}.${client}`, harnesses[client] ? "ok" : "error", harnesses[client] ? "client is declared" : "client missing from integrations/harnesses.yaml");
    for (const [name, bundle] of Object.entries(bundles.bundles || {})) for (const server of (bundle as any).servers || []) add(checks, `reference.bundle.${name}.${server}`, registry[server] ? "ok" : "error", registry[server] ? "server is declared" : "server missing from MCP registry");
    for (const [name, contract] of Object.entries(marketplace)) add(checks, `reference.marketplace-harness.${name}`, harnesses[name] && /^[a-z0-9][a-z0-9-]+$/.test(String((contract as any).marketplace_slug || "")) ? "ok" : "error", harnesses[name] ? "harness and marketplace slug are declared" : "invalid harness or marketplace slug");
    const defaultSkills = readYaml<any>("integrations/skills.yaml").default_skills || [];
    for (const skill of defaultSkills) {
      const skipped = skill.not_applicable || [];
      for (const harness of Object.keys(harnesses)) {
        const covered = skipped.includes(harness) || String((skill.installs || {})[harness] || "").length > 0;
        add(checks, `reference.default-skill.${skill.id}.${harness}`, covered ? "ok" : "error", covered ? "install path declared" : "harness has no install path or exemption");
      }
      add(checks, `default-skill.${skill.id}.pin`, /^[0-9a-f]{40}$/.test(String(skill.pinned_commit || "")) ? "ok" : "error", "pinned to a full commit SHA");
    }
    const routeValues = Object.values(routing.routes || {}) as any[];
    add(checks, "routing.providers", routeValues.every((route) => !route.primary || providers[route.primary]) ? "ok" : "error", "routing providers are declared");
    for (const [name, metadata] of Object.entries(onePassword.providers || {})) add(checks, `reference.onepassword.${name}`, providers[name] && String((metadata as any).reference || "").startsWith("op://") && /^[A-Z][A-Z0-9_]*$/.test(String((metadata as any).env || "")) ? "ok" : "error", providers[name] ? "reference and environment mapping are valid" : "invalid 1Password mapping");
    for (const name of Object.keys(models.providers || {})) add(checks, `reference.model-provider.${name}`, providers[name] ? "ok" : "error", providers[name] ? "provider is declared" : "model provider missing from providers/providers.yaml");
    for (const name of Object.keys(fallback.providers || {})) add(checks, `reference.model-catalog.${name}`, models.providers?.[name] ? "ok" : "error", models.providers?.[name] ? "catalogued" : "missing from integrations/models.yaml");
  } catch (error) {
    add(checks, "cross-references", "error", String(error));
  }

  try {
    const manifest = readYaml<any>("sync/manifest.yaml");
    const missing = (manifest.items || []).filter((item: any) => !fileExists(item.source)).map((item: any) => item.source);
    add(checks, "sync.manifest", missing.length === 0 ? "ok" : "error", missing.length === 0 ? "all sources exist" : `missing: ${missing.join(", ")}`);
    // A target owns its spec registry; sync may ship the template but never the live file.
    const registryWriters = (manifest.items || []).filter((item: any) => String(item.destination || "").replace(/^\.\//, "") === ".agent-configs/specs.toml").map((item: any) => item.id);
    add(checks, "sync.manifest.registry", registryWriters.length === 0 ? "ok" : "error", registryWriters.length === 0 ? "no item writes a target's .agent-configs/specs.toml" : `items overwrite the target-owned registry: ${registryWriters.join(", ")}`);
  } catch (error) {
    add(checks, "sync.manifest", "error", String(error));
  }

  // The registry decoder loads Effect, so `validate`, `check` and verify.sh need it too. It is
  // imported here rather than at the top so that a failure to load it is one clear check
  // instead of a crash before any other check runs.
  let registry: typeof import("./spec-registry.ts") | undefined;
  try {
    registry = await import("./spec-registry.ts");
  } catch (error) {
    add(checks, "verification", "error", decoderLoadProblem(error));
  }
  if (registry !== undefined) {
    try {
      const registries = VERIFICATION_REGISTRIES.filter((item) => fileExists(item.file)).map((item) => ({ ...item, text: readText(item.file) }));
      checks.push(...verificationChecks({
        toolchains: readYaml(TOOLCHAINS_FILE),
        policy: readYaml(POLICY_FILE),
        registries,
        decode: registry.parseRegistry,
        vocabulary: { tools: registry.SPEC_TOOLS, kinds: registry.SPEC_KINDS, gates: registry.SPEC_GATES, statuses: registry.SPEC_STATUSES },
      }));
    } catch (error) {
      add(checks, "verification", "error", String(error));
    }
  }
  const summary = { ok: checks.filter((check) => check.status === "ok").length, error: checks.filter((check) => check.status === "error").length };
  const result = { schema_version: 1, summary, checks };
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    for (const check of checks) console.log(`${check.status === "ok" ? "✓" : "✗"} ${check.id}: ${check.detail}`);
    console.log(`Validation: ${summary.error} error(s)`);
  }
  return { exitCode: summary.error > 0 ? 1 : 0, result };
}
