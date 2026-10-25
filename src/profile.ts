import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readYaml } from "./core.ts";

export function profileCommand(args: string[]): number {
  const command = args.shift() || "list";
  const json = args.includes("--json");
  const contract = readYaml<any>(join(ROOT, "integrations", "operator-contract.yaml"));
  const packs = readYaml<any>(join(ROOT, "integrations", "workflow-packs.yaml"));
  const bundles = readYaml<any>(join(ROOT, "integrations", "capability-bundles.yaml"));
  const profiles = contract.profiles || {};
  if (command === "list") {
    const result = { schema_version: 1, profiles: Object.keys(profiles).sort(), workflow_packs: Object.keys(packs.packs || {}).sort() };
    if (json) console.log(JSON.stringify(result, null, 2));
    else { console.log(`Profiles: ${result.profiles.join(", ")}`); console.log(`Workflow packs: ${result.workflow_packs.join(", ")}`); }
    return 0;
  }
  if (command !== "show" || !args[0]) { console.error("Usage: agentctl profile list|show NAME [--json]"); return 2; }
  const name = args[0];
  const profile = profiles[name];
  if (!profile) { console.error(`unknown profile ${JSON.stringify(name)}; choose ${Object.keys(profiles).sort().join(", ")}`); return 2; }
  const referencedBundles = Object.fromEntries((profile.bundles || []).map((bundleName: string) => [bundleName, bundles.bundles?.[bundleName]]));
  const referencedWorkflows = Object.fromEntries((profile.workflows || []).map((workflowName: string) => {
    const document = join(ROOT, "workflows", `${workflowName}.md`);
    return [workflowName, existsSync(document) ? { type: "document", path: `workflows/${workflowName}.md` } : packs.packs?.[workflowName]];
  }));
  const result = { schema_version: 1, profile: name, policy: profile, bundles: referencedBundles, workflows: referencedWorkflows, credential_values_included: false };
  if (json) console.log(JSON.stringify(result, null, 2));
  else { console.log(`Profile: ${name}`); console.log(`Bundles: ${(profile.bundles || []).join(", ")}`); console.log(`Workflows: ${(profile.workflows || []).join(", ")}`); console.log(`Default chain: ${profile.default_chain}`); console.log(`Mutation policy: ${profile.mutation_policy}`); }
  return 0;
}
