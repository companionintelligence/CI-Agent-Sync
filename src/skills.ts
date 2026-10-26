import { join } from "node:path";
import { HOME, directoryExists, readYaml } from "./core.ts";

type DefaultSkill = { id: string; pinned_commit: string; installs?: Record<string, string>; not_applicable?: string[] };

// Skill folders each harness reads from; harnesses absent here are reported as manual.
const SKILL_DIRS: Record<string, string[]> = {
  claude: [join(HOME, ".claude", "skills"), join(HOME, ".claude", "plugins")],
  codex: [join(HOME, ".codex", "skills"), join(HOME, ".agents", "skills")],
  opencode: [join(HOME, ".config", "opencode", "skills")],
  hermes: [join(HOME, ".hermes", "skills")],
  openclaw: [join(HOME, ".openclaw", "skills")],
  pi: [join(HOME, ".pi", "skills")],
};

// Plan-only: reports where each default skill is present and the reviewed install
// step for the rest. It never installs; installs stay explicit and audit-first.
export function skillsCommand(args: string[]): number {
  if (args[0] !== "plan") {
    console.error("usage: agentctl skills plan [--json]");
    return 2;
  }
  const skills: DefaultSkill[] = readYaml<any>("integrations/skills.yaml").default_skills || [];
  const harnesses = Object.keys(readYaml<any>("integrations/harnesses.yaml").harnesses || {});
  const rows = skills.flatMap((skill) =>
    harnesses.map((harness) => {
      if (skill.not_applicable?.includes(harness)) return { skill: skill.id, harness, status: "not_applicable", action: "" };
      const present = (SKILL_DIRS[harness] || []).some((dir) => directoryExists(join(dir, skill.id)));
      const status = present ? "present" : SKILL_DIRS[harness] ? "missing" : "manual_check";
      return { skill: skill.id, harness, status, action: present ? "" : skill.installs?.[harness] || "" };
    }),
  );
  if (args.includes("--json")) process.stdout.write(`${JSON.stringify({ schema_version: 1, rows }, null, 2)}\n`);
  else for (const row of rows) console.log(`${row.skill} @ ${row.harness}: ${row.status}${row.action ? `\n    ${row.action}` : ""}`);
  return 0;
}
