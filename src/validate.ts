import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, fileExists, readJson, readYaml } from "./core.ts";

type Check = { id: string; status: "ok" | "error"; detail: string };

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

export function validateStore(options: { json?: boolean } = {}): { exitCode: number; result: any } {
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
  } catch (error) {
    add(checks, "sync.manifest", "error", String(error));
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
