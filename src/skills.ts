import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { HOME, directoryExists, readYaml } from "./core.ts";

type DefaultSkill = { id: string; repository?: string; skill_file?: string; skill_sha256?: string; copy_targets?: Record<string, string>; pinned_commit: string; installs?: Record<string, string>; not_applicable?: string[] };

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
  if (args[0] === "apply") return skillsApply(args);
  if (args[0] !== "plan") {
    console.error("usage: agentctl skills plan [--json] | agentctl skills apply [--confirm] [--harness NAME]");
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

// Writes only the pinned SKILL.md, only to declared targets, never overwriting an
// existing file, and only after the downloaded bytes match the reviewed sha256.
function skillsApply(args: string[]): number {
  const confirm = args.includes("--confirm");
  const only = args.includes("--harness") ? args[args.indexOf("--harness") + 1] : "";
  return applyAll(confirm, only) ? 0 : 1;
}

function applyAll(confirm: boolean, only: string): boolean {
  const skills: DefaultSkill[] = readYaml<any>("integrations/skills.yaml").default_skills || [];
  let ok = true;
  for (const skill of skills) {
    const targets = Object.entries(skill.copy_targets || {})
      .filter(([harness]) => !only || harness === only)
      .map(([harness, raw]) => ({ harness, path: raw.replace(/^~(?=\/)/, HOME) }));
    const pending = targets.filter((target) => !existsSync(target.path));
    for (const target of targets) if (!pending.some((p) => p.harness === target.harness)) console.log(`${skill.id} @ ${target.harness}: already present`);
    if (!pending.length) continue;
    if (!confirm) {
      for (const target of pending) console.log(`${skill.id} @ ${target.harness}: would write ${target.path} (re-run with --confirm)`);
      continue;
    }
    const url = `https://raw.githubusercontent.com/${skill.repository}/${(skill as any).pinned_commit}/${skill.skill_file || "SKILL.md"}`;
    const download = fetchBytes(url);
    if (!download || createHash("sha256").update(download).digest("hex") !== skill.skill_sha256) {
      console.error(`${skill.id}: download failed or sha256 does not match the reviewed pin; nothing written`);
      ok = false;
      continue;
    }
    for (const target of pending) {
      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(target.path, download, { flag: "wx" });
      console.log(`${skill.id} @ ${target.harness}: wrote ${target.path}`);
    }
  }
  return ok;
}

function fetchBytes(url: string): Buffer | null {
  const result = spawnSync("curl", ["-fsSL", "--max-time", "20", url], { maxBuffer: 5_000_000 });
  return result.status === 0 ? result.stdout : null;
}
