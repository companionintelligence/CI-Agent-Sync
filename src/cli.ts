#!/usr/bin/env node

import { join } from "node:path";
import { companionCommand } from "./companion.ts";
import { ROOT, commandPath, legacyScript, legacyStore, outputResult, parseArgs, runCommand, runInteractive } from "./core.ts";
import { conformanceCommand, harnessSmokeCommand } from "./diagnostics.ts";
import { startAtlas } from "./atlas-web.ts";
import { createBackup, renderArtifacts } from "./operations.ts";
import { doctor } from "./doctor.ts";
import { profileCommand } from "./profile.ts";
import { platformCommand } from "./platform.ts";
import { validateStore } from "./validate.ts";

function usage(): void {
  console.log(`CI Agent Sync — portable Companion Intelligence control plane

Usage:
  agentctl atlas [--open] [--bind ADDRESS] [--port PORT]
  agentctl doctor [--json] [--strict]
  agentctl validate [--json]
  agentctl profile list|show NAME [--json]
  agentctl companion status|hub|memory|tui [options]
  agentctl conformance [--json] [--timeout SECONDS]
  agentctl harness-smoke [--json] [--live-local] [--agent NAME] [--timeout SECONDS]
  agentctl platform preflight|evidence [--json] [--strict] [--output PATH]
  agentctl backup [--dry-run] [--output PATH]
  agentctl render [--agent NAME] [--machine NAME] [--output PATH]
  agentctl <compatibility command> [...]

The TypeScript control plane owns the wizard, doctor, validation, profile,
backup, render, and Companion Hub/Memory bridge. Specialized legacy commands
remain available through an explicit compatibility boundary while they are
being ported; credentials are never printed or committed.
`);
}

function parseRender(args: string[]): number {
  const parsed = parseArgs(args);
  try {
    const result = renderArtifacts({ agent: parsed.values.get("--agent"), machine: parsed.values.get("--machine"), output: parsed.values.get("--output") });
    console.log(`Generated ${result.outputs.length} portable artifacts under ${result.output}`);
    return 0;
  } catch (error) {
    console.error(String(error));
    return 2;
  }
}

function parseBackup(args: string[]): number {
  const parsed = parseArgs(args);
  try {
    const result = createBackup({ dryRun: parsed.flags.has("--dry-run"), output: parsed.values.get("--output") });
    if (parsed.flags.has("--dry-run")) {
      console.log(`Backup plan: ${result.output}`);
      for (const item of result.records) console.log(`  ${item.status}: ${item.path}`);
    } else {
      console.log(`Created redacted agent backup: ${result.output}`);
      console.log("Native credentials, OAuth sessions, app databases, and device identities were not copied.");
    }
    return result.records.some((item) => item.status === "redaction-error") ? 1 : 0;
  } catch (error) {
    console.error(String(error));
    return 1;
  }
}

function legacy(script: string, args: string[]): number {
  return outputResult(legacyScript(script, args));
}

async function storeCommand(args: string[]): Promise<number> {
  const target = args[0];
  if (!target || target === "help" || target === "--help") { usage(); return target ? 0 : 2; }
  if (target === "render") return parseRender(args.slice(1));
  if (target === "backup") return parseBackup(args.slice(1));
  if (target === "doctor") return (await doctor({ json: args.includes("--json"), strict: args.includes("--strict") })).exitCode;
  if (target === "fallbacks") return legacyStore(args.slice(0), 60_000).exitCode ?? 1;
  return outputResult(legacyStore(args));
}

async function agentctlCommand(args: string[]): Promise<number> {
  const target = args.shift();
  if (!target || target === "help" || target === "--help" || target === "-h") { usage(); return 0; }
  switch (target) {
    case "atlas": return startAtlas(args);
    case "doctor": return (await doctor({ json: args.includes("--json"), strict: args.includes("--strict") })).exitCode;
    case "validate": return validateStore({ json: args.includes("--json") }).exitCode;
    case "profile":
    case "profiles": return profileCommand(args);
    case "companion": return companionCommand(args);
    case "tui": return companionCommand(["tui", ...args]);
    case "backup": return parseBackup(args);
    case "render": return parseRender(args);
    case "inventory": return outputResult(legacyStore(["inventory", ...args]));
    case "credentials":
    case "audit":
    case "fallbacks":
    case "sync":
    case "vscode":
    case "repos":
      return outputResult(legacyStore([target, ...args]));
    case "health": return (await doctor({ json: args.includes("--json"), strict: args.includes("--strict") })).exitCode;
    case "test": {
      const result = runCommand("npm", ["test", "--", ...args], { cwd: ROOT, timeoutMs: 120_000 });
      return outputResult(result);
    }
    case "conformance": return await conformanceCommand(args);
    case "harness-smoke": return await harnessSmokeCommand(args);
    case "platform": return await platformCommand(args);
    case "readiness": return legacy("readiness.rb", args);
    case "report":
    case "export-report": return legacy("export-report.rb", args);
    case "ledger": return legacy("action-ledger.rb", args);
    case "hub": return legacy("hub-control-room.rb", args);
    case "memory": return args[0] === "smoke" ? legacy("memory-control-room.rb", args.slice(1)) : legacy("memory-control-room.rb", args);
    case "fleet": return args[0] === "smoke" ? legacy("hub-fleet-smoke.rb", args.slice(1)) : 2;
    case "marketplace": return args[0] === "audit" ? legacy("marketplace-audit.rb", args.slice(1)) : 2;
    case "deploy": return args[0] === "doctor" ? legacy("deploy-doctor.rb", args.slice(1)) : 2;
    case "repair": return args[0] === "openclaw" ? legacy("repair-openclaw.rb", args.slice(1)) : 2;
    case "install":
    case "bootstrap": return runInteractive("zsh", [join(ROOT, "scripts", "bootstrap-machine.zsh"), ...args]);
    case "openclaw": return runInteractive(join(ROOT, "bin", "openclaw-runtime"), args);
    case "check": {
      const validation = validateStore({ json: false });
      const required = ["web/index.html", "web/styles.css", "web/app.js", "web/assets/ci-common/tokens.css"];
      const missing = required.filter((file) => !commandPath(join(ROOT, file)));
      if (missing.length) { console.error(`Missing assets: ${missing.join(", ")}`); return 1; }
      return validation.exitCode;
    }
    default:
      console.error(`Unknown agentctl command: ${target}`);
      usage();
      return 2;
  }
}

const argv = process.argv.slice(2);
const mode = argv.shift() || "agentctl";
const exitCode = mode === "store" ? await storeCommand(argv) : mode === "agentctl" ? await agentctlCommand(argv) : await agentctlCommand([mode, ...argv]);
process.exitCode = exitCode;
